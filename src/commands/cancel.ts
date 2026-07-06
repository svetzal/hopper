import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.ts";
import { booleanFlag, unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { TaskType } from "../constants.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import type { ConfirmFn } from "../gateways/confirm-gateway.ts";
import { createConfirmGateway } from "../gateways/confirm-gateway.ts";
import type { GitGateway } from "../gateways/git-gateway.ts";
import { createGitGateway } from "../gateways/git-gateway.ts";
import { buildEngineeringBranchName } from "../git-workflow.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { cancelItem, findItem } from "../store.ts";

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Tear down the worktree + work branch a stuck engineering run left behind.
 *
 * Only reached when an `in_progress` engineering item is cancelled — those are
 * the ones hopper parks with a live worktree at `~/.hopper/worktrees/<id>` and
 * an unmerged `hopper-eng/<slug>-<prefix>` branch. Best-effort: failures become
 * warnings rather than aborting the cancel, since the status transition has
 * already been persisted and a leftover worktree is a tidiness issue, not a
 * correctness one. Order matters — the worktree must be removed before the
 * branch, because git refuses to delete a branch still checked out in a linked
 * worktree. The branch is abandoned (unmerged), so it needs a force delete.
 */
async function teardownEngineeringWorktree(
  item: Item,
  git: GitGateway,
  isDirectory: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const warnings: string[] = [];
  if (!item.workingDir) return warnings;

  const worktreePath = join(homedir(), ".hopper", "worktrees", item.id);
  const workBranch = buildEngineeringBranchName(item.id, item.engineeringBranchSlug ?? null);

  if (await isDirectory(worktreePath)) {
    try {
      await git.worktreeRemove(item.workingDir, worktreePath);
    } catch (e) {
      warnings.push(`Could not remove worktree ${worktreePath}: ${toErrorMessage(e)}`);
    }
  }

  try {
    await git.forceDeleteBranch(item.workingDir, workBranch);
  } catch (e) {
    warnings.push(`Could not delete branch ${workBranch}: ${toErrorMessage(e)}`);
  }

  return warnings;
}

export function cancelCommand(
  parsed: ParsedArgs,
  git: GitGateway = createGitGateway(),
  isDirectory: (path: string) => Promise<boolean> = pathIsDirectory,
  confirm: ConfirmFn = createConfirmGateway(),
): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    const id = unwrapPositional(parsed, 0, "Usage: hopper cancel <item-id>");
    const yes = booleanFlag(parsed, "yes");

    // Cancelling an in-progress engineering item force-deletes its unmerged work
    // branch (and worktree) — commits are lost irrecoverably. Confirm BEFORE the
    // state transition so a declined prompt leaves the item fully untouched. The
    // confirm gateway fails closed when non-interactive, so an unattended caller
    // must pass --yes. Queued/scheduled/blocked cancels destroy nothing and skip
    // this gate.
    const target = unwrap(await findItem(id));
    const destroysUnmergedWork =
      target.status === "in_progress" && target.type === TaskType.ENGINEERING && !!target.branch;

    if (destroysUnmergedWork && !yes) {
      const workBranch = buildEngineeringBranchName(
        target.id,
        target.engineeringBranchSlug ?? null,
      );
      const confirmed = await confirm(
        `Cancelling ${shortId(target.id)} force-deletes its unmerged work branch ${workBranch} and worktree — commits will be lost.`,
      );
      if (!confirmed) {
        return {
          status: "error",
          message: `Cancel aborted — ${shortId(target.id)} left untouched. Re-run with --yes to force.`,
        };
      }
    }

    const outcome = unwrap(await cancelItem(id));
    const { item, blockedDependentCount, previousStatus } = outcome;

    const warnings: string[] = [];
    if (blockedDependentCount > 0) {
      warnings.push(
        `Warning: ${blockedDependentCount} item(s) depend on this item and will remain blocked.`,
      );
    }

    // A cancelled in-progress engineering run leaves a live worktree + branch;
    // clean them up so abandoning doesn't orphan disk state. Nothing else will
    // ever revisit a cancelled item to do it.
    if (previousStatus === "in_progress" && item.type === TaskType.ENGINEERING && item.branch) {
      warnings.push(...(await teardownEngineeringWorktree(item, git, isDirectory)));
    }

    const humanOutput = item.recurrence
      ? `Cancelled: ${item.title} (recurrence stopped)`
      : `Cancelled: ${item.title}`;

    return {
      status: "success",
      data: item,
      humanOutput,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
