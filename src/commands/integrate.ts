import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { booleanFlag, unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { TaskType } from "../constants.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import { catchCommandError, unwrap } from "../result.ts";
import { findItem } from "../store.ts";

export type IntegrateDryRunResult = {
  dryRun: true;
  itemId: string;
  workingDir: string;
  branch: string;
  targetBranch: string;
  commands: string[];
  keepWorktree: boolean;
};

export type IntegrateResult = {
  dryRun?: false;
  itemId: string;
  workingDir: string;
  branch: string;
  targetBranch: string;
  keepWorktree: boolean;
  worktreeRemoved: boolean;
  /** Target-branch HEAD SHA before the merge. */
  oldHead: string;
  /** Target-branch HEAD SHA after the merge. Always differs from oldHead. */
  newHead: string;
};

const shortSha = (sha: string): string => sha.slice(0, 8);

/**
 * Tri-state result of a worktree path check:
 * - "directory" — path exists and is a directory (valid worktree)
 * - "file"      — path exists but is a regular file (invalid worktree)
 * - "missing"   — path does not exist
 */
export type WorktreePathState = "directory" | "file" | "missing";

async function defaultCheckWorktree(path: string): Promise<WorktreePathState> {
  try {
    const s = await stat(path);
    return s.isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

export function integrateCommand(
  parsed: ParsedArgs,
  git: GitGateway = createGitGateway(),
  checkWorktree: (path: string) => Promise<WorktreePathState> = defaultCheckWorktree,
): Promise<CommandResult<IntegrateDryRunResult | IntegrateResult>> {
  return catchCommandError(
    async (): Promise<CommandResult<IntegrateDryRunResult | IntegrateResult>> => {
      const id = unwrapPositional(parsed, 0, "Usage: hopper integrate <item-id>");

      // Safe by default: preview the merge unless --apply is given. `--dry-run`
      // is retained as an accepted no-op — preview is now the default, so it
      // means the same thing and existing muscle memory keeps working.
      const apply = booleanFlag(parsed, "apply");
      const keepWorktree = booleanFlag(parsed, "keep-worktree");

      const item = unwrap(await findItem(id));

      const { workingDir, branch } = item;
      if (!workingDir || !branch) {
        return {
          status: "error",
          message: `Item ${shortId(item.id)} has no workingDir/branch; nothing to integrate.`,
        };
      }

      // Engineering items store the TARGET branch in `item.branch`; the actual
      // work lives on `hopper-eng/<slug>-<prefix>`. Merging `branch` into itself
      // would be a silent no-op, so resolve the surviving work branch and merge
      // that into the target. Generic/legacy items keep the original semantics:
      // the work branch is `item.branch`, merged into `main`.
      const isEngineering = item.type === TaskType.ENGINEERING;
      const targetBranch = isEngineering ? branch : "main";
      const workBranch = isEngineering
        ? buildEngineeringBranchName(item.id, item.engineeringBranchSlug ?? null)
        : branch;

      const worktreePath = join(homedir(), ".hopper", "worktrees", item.id);

      // `failed` is integrable because a failed engineering run preserves its
      // worktree + work branch — integrate is the "salvage the work anyway"
      // recovery path.
      if (
        item.status !== "completed" &&
        item.status !== "in_progress" &&
        item.status !== "failed"
      ) {
        return {
          status: "error",
          message: `Cannot integrate item with status '${item.status}'. Only 'completed', 'in_progress', or 'failed' items can be integrated.`,
        };
      }

      if (item.status === "in_progress" || item.status === "failed") {
        const worktreeState = await checkWorktree(worktreePath);
        if (worktreeState !== "directory") {
          const reason =
            worktreeState === "file" ? "path exists but is not a directory" : "path does not exist";
          return {
            status: "error",
            message: `Cannot integrate item ${shortId(item.id)}: status is ${item.status} but worktree ${reason}: ${worktreePath}`,
          };
        }
      }

      const commands = [
        `git -C ${workingDir} checkout ${targetBranch}`,
        `git -C ${workingDir} merge ${workBranch} --no-edit`,
        ...(keepWorktree
          ? []
          : [
              `git -C ${workingDir} branch -d ${workBranch}`,
              `git -C ${workingDir} worktree remove --force ${worktreePath}`,
            ]),
      ];

      if (!apply) {
        return {
          status: "success",
          data: {
            dryRun: true,
            itemId: item.id,
            workingDir,
            branch: workBranch,
            targetBranch,
            commands,
            keepWorktree,
          },
          humanOutput: `Preview — no changes made. These commands would run:\n${commands
            .map((c) => `  ${c}`)
            .join("\n")}\n\nRe-run with --apply to execute.`,
        };
      }

      await git.checkout(workingDir, targetBranch);

      // Capture HEAD before and after so we can prove the merge actually
      // advanced the target branch. A merge that leaves HEAD unchanged
      // ("Already up to date") integrated nothing and must never report success.
      const oldHead = await git.revParse(workingDir, "HEAD");

      const mergeResult = await git.mergeNoEdit(workingDir, workBranch);
      if (mergeResult.exitCode !== 0) {
        const detail = mergeResult.stderr.trim();
        return {
          status: "error",
          message: `Merge of ${workBranch} into ${targetBranch} failed${detail ? `: ${detail}` : "."}`,
        };
      }

      const newHead = await git.revParse(workingDir, "HEAD");
      if (oldHead === newHead) {
        return {
          status: "error",
          message:
            `Merge of ${workBranch} into ${targetBranch} was a no-op — HEAD stayed at ${shortSha(oldHead)}, ` +
            `so nothing was integrated. The work branch may already be merged, missing, or empty. ` +
            `No cleanup was performed.`,
        };
      }

      const warnings: string[] = [];
      let worktreeRemoved = false;

      if (!keepWorktree) {
        try {
          await git.deleteBranch(workingDir, workBranch);
        } catch (e) {
          warnings.push(`Could not delete branch ${workBranch}: ${toErrorMessage(e)}`);
        }

        try {
          const worktreeState = await checkWorktree(worktreePath);
          if (worktreeState === "directory") {
            await git.worktreeRemove(workingDir, worktreePath);
            worktreeRemoved = true;
          }
        } catch (e) {
          warnings.push(`Could not remove worktree ${worktreePath}: ${toErrorMessage(e)}`);
        }
      }

      return {
        status: "success",
        data: {
          itemId: item.id,
          workingDir,
          branch: workBranch,
          targetBranch,
          keepWorktree,
          worktreeRemoved,
          oldHead,
          newHead,
        },
        humanOutput: `Integrated ${shortId(item.id)}: merged ${workBranch} into ${targetBranch} of ${workingDir} (${shortSha(oldHead)} → ${shortSha(newHead)}).`,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  );
}
