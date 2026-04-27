import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { booleanFlag, requirePositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import { findItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

export async function integrateCommand(
  parsed: ParsedArgs,
  git: GitGateway = createGitGateway(),
): Promise<CommandResult> {
  const idArg = requirePositional(parsed, 0, "Usage: hopper integrate <item-id>");
  if (!idArg.ok) return idArg.error;

  const dryRun = booleanFlag(parsed, "dry-run");
  const keepWorktree = booleanFlag(parsed, "keep-worktree");

  return withStoreError(async () => {
    const item = await findItem(idArg.value);

    const { workingDir, branch } = item;
    if (!workingDir || !branch) {
      return {
        status: "error",
        message: `Item ${shortId(item.id)} has no workingDir/branch; nothing to integrate.`,
      };
    }

    const worktreePath = join(homedir(), ".hopper", "worktrees", item.id);

    if (item.status !== "completed" && item.status !== "in_progress") {
      return {
        status: "error",
        message: `Cannot integrate item with status '${item.status}'. Only 'completed' or 'in_progress' items can be integrated.`,
      };
    }

    if (item.status === "in_progress") {
      const worktreeExists = await Bun.file(worktreePath).exists();
      if (!worktreeExists) {
        return {
          status: "error",
          message: `Cannot integrate item with status '${item.status}'. Only 'completed' or 'in_progress' items can be integrated.`,
        };
      }
    }

    const commands = [
      `git -C ${workingDir} checkout main`,
      `git -C ${workingDir} merge ${branch} --no-edit`,
      ...(keepWorktree
        ? []
        : [
            `git -C ${workingDir} branch -d ${branch}`,
            `git -C ${workingDir} worktree remove --force ${worktreePath}`,
          ]),
    ];

    if (dryRun) {
      return {
        status: "success",
        data: {
          dryRun: true,
          itemId: item.id,
          workingDir,
          branch,
          targetBranch: "main",
          commands,
          keepWorktree,
        },
        humanOutput: `Dry run:\n${commands.map((c) => `  ${c}`).join("\n")}`,
      };
    }

    await git.checkout(workingDir, "main");

    const mergeResult = await git.mergeNoEdit(workingDir, branch);
    if (mergeResult.exitCode !== 0) {
      return {
        status: "error",
        message: `Merge failed: ${mergeResult.stderr.trim()}`,
      };
    }

    const warnings: string[] = [];
    let worktreeRemoved = false;

    if (!keepWorktree) {
      try {
        await git.deleteBranch(workingDir, branch);
      } catch (e) {
        warnings.push(`Could not delete branch ${branch}: ${toErrorMessage(e)}`);
      }

      try {
        const worktreeExists = await Bun.file(worktreePath).exists();
        if (worktreeExists) {
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
        branch,
        targetBranch: "main",
        keepWorktree,
        worktreeRemoved,
      },
      humanOutput: `Integrated ${shortId(item.id)} from ${branch} into main of ${workingDir}.`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
