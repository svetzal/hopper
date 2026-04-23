import {
  buildNewItem,
  formatValidationError,
  resolveDependencies,
  resolveScheduling,
  validateDirBranch,
  validateRetries,
  validateTaskType,
  validateTimesSpec,
} from "../add-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { Status, TaskType } from "../constants.ts";
import { shortId } from "../format.ts";
import { findPreset } from "../presets.ts";
import type { Priority } from "../priority.ts";
import { parsePriority, priorityBadge } from "../priority.ts";
import { addItem, loadItems } from "../store.ts";
import { mergeTags, normalizeTags, tagBadge } from "../tags.ts";
import type { TitleGenerator } from "../titler.ts";
import { withStoreError } from "./with-store-error.ts";

/**
 * Optional callback that resolves a craftsperson agent for an engineering
 * item. Called only when `--type engineering` is set, `--agent` is not, and
 * the item has a working directory to probe for project markers.
 *
 * Returns `null` when no suitable agent exists — the item is then enqueued
 * with no agent, and the worker runs the execute phase with Claude's default.
 */
export type AgentResolver = (input: {
  title: string;
  description: string;
  workingDir: string;
}) => Promise<string | null>;

export async function addCommand(
  parsed: ParsedArgs,
  titler: TitleGenerator,
  readStdin: () => Promise<string> = () => new Response(Bun.stdin.stream()).text(),
  resolveAgent?: AgentResolver,
): Promise<CommandResult> {
  return withStoreError(async () => {
    // 1. Resolve preset (I/O)
    const presetName = stringFlag(parsed, "preset");
    let preset: Awaited<ReturnType<typeof findPreset>>;
    if (presetName) {
      preset = await findPreset(presetName);
      if (!preset) {
        return { status: "error", message: `No preset found with name: ${presetName}` };
      }
    }

    // 2. Get description from args or stdin (I/O)
    let description = parsed.positional[0] ?? "";

    if (!description && !process.stdin.isTTY) {
      description = (await readStdin()).trim();
    }

    if (!description && preset) {
      description = preset.description;
    }

    // 3. Validate description exists
    if (!description) {
      return { status: "error", message: formatValidationError({ code: "MISSING_DESCRIPTION" }) };
    }

    // 4. Generate title (I/O)
    const title = await titler.generateTitle(description);

    // 5. Resolve dir/branch/command from args + preset
    const dir = stringFlag(parsed, "dir") ?? preset?.workingDir;
    const branch = stringFlag(parsed, "branch") ?? preset?.branch;
    const command = stringFlag(parsed, "command") ?? preset?.command;

    // 5a. Resolve and validate task type + agent
    const typeResult = validateTaskType(stringFlag(parsed, "type") ?? preset?.type);
    if (!typeResult.ok) {
      return { status: "error", message: formatValidationError(typeResult.error) };
    }
    const type = typeResult.value;
    let agent = stringFlag(parsed, "agent") ?? preset?.agent;

    // Parse --retries. Preset fallback is an already-validated integer, so we
    // only need to validate the CLI string form.
    const retriesRaw = stringFlag(parsed, "retries");
    const retriesResult = validateRetries(retriesRaw);
    if (!retriesResult.ok) {
      return { status: "error", message: formatValidationError(retriesResult.error) };
    }
    const retries = retriesResult.value ?? preset?.retries;

    // Auto-resolve a craftsperson for engineering items when the caller didn't
    // pin one explicitly. Failures are swallowed — a missing agent is always
    // preferable to a wrong one, and the worker runs fine without.
    if (!agent && type === TaskType.ENGINEERING && dir && resolveAgent) {
      try {
        const resolved = await resolveAgent({ title, description, workingDir: dir });
        if (resolved) agent = resolved;
      } catch {
        // failure swallowed — missing agent is preferable to a wrong one
      }
    }

    // 6. Validate dir/branch combination (accounting for task type)
    const dirBranchError = validateDirBranch(dir, branch, command, type);
    if (dirBranchError) {
      return { status: "error", message: formatValidationError(dirBranchError) };
    }

    // 7. Parse priority
    let priority: Priority | undefined;
    const priorityFlag = stringFlag(parsed, "priority");
    if (priorityFlag) {
      const priorityResult = parsePriority(priorityFlag);
      if (!priorityResult.ok) {
        return { status: "error", message: priorityResult.error };
      }
      priority = priorityResult.value;
    }

    // 8. Validate --times spec
    const everySpec = stringFlag(parsed, "every");
    const timesSpec = stringFlag(parsed, "times");
    const timesResult = validateTimesSpec(timesSpec, everySpec);
    if (!timesResult.ok) {
      return { status: "error", message: formatValidationError(timesResult.error) };
    }

    // 9. Resolve scheduling
    const afterSpec = stringFlag(parsed, "after");
    const untilSpec = stringFlag(parsed, "until");
    const schedulingResult = resolveScheduling(
      everySpec,
      afterSpec,
      untilSpec,
      timesResult.value,
      new Date(),
    );
    if (!schedulingResult.ok) {
      return { status: "error", message: formatValidationError(schedulingResult.error) };
    }

    // 10. Normalize tags
    const rawTags = parsed.arrayFlags.tag ?? [];
    let tags: string[] | undefined;
    const warnings: string[] = [];
    if (rawTags.length > 0 || preset?.tags?.length) {
      const tagResult = normalizeTags(rawTags);
      if (!tagResult.ok) return { status: "error", message: tagResult.error };
      const presetTags = preset?.tags ?? [];
      tags = mergeTags(presetTags, tagResult.value);
    }

    // 11. Resolve dependencies (I/O)
    const afterItemIds = parsed.arrayFlags["after-item"] ?? [];
    let dependsOn: string[] | undefined;
    let itemStatus = schedulingResult.value.status;

    if (afterItemIds.length > 0) {
      const allItems = await loadItems();
      const depResult = resolveDependencies(afterItemIds, allItems);
      if (!depResult.ok) {
        return { status: "error", message: formatValidationError(depResult.error) };
      }
      for (const warning of depResult.value.warnings) {
        warnings.push(warning);
      }
      dependsOn = depResult.value.resolvedIds;
      itemStatus = Status.BLOCKED;
    }

    // 12. Build item
    const item = buildNewItem({
      id: crypto.randomUUID(),
      title,
      description,
      status: itemStatus,
      createdAt: new Date().toISOString(),
      priority,
      scheduledAt: schedulingResult.value.scheduledAt,
      dir,
      branch,
      command,
      recurrence: schedulingResult.value.recurrence,
      dependsOn,
      tags,
      type,
      agent,
      retries,
    });

    // 13. Save item (I/O)
    await addItem(item);

    // 14. Build human output
    const presetSuffix = preset ? ` (from preset: ${preset.name})` : "";
    const pBadge = priorityBadge(priority);
    const tBadge = tagBadge(tags);
    let humanOutput: string;
    if (dependsOn) {
      const depBadge = dependsOn.map((id) => shortId(id)).join(", ");
      humanOutput = `Added: ${title}${pBadge}${tBadge} (blocked on: ${depBadge})${presetSuffix}`;
    } else if (schedulingResult.value.recurrence) {
      humanOutput = `Added: ${title}${pBadge}${tBadge} (recurring every ${schedulingResult.value.recurrence.interval}, next run: ${schedulingResult.value.scheduledAt ? new Date(schedulingResult.value.scheduledAt).toLocaleString() : "unknown"})${presetSuffix}`;
    } else if (schedulingResult.value.scheduledAt) {
      humanOutput = `Added: ${title}${pBadge}${tBadge} (scheduled for ${new Date(schedulingResult.value.scheduledAt).toLocaleString()})${presetSuffix}`;
    } else {
      humanOutput = `Added: ${title}${pBadge}${tBadge}${presetSuffix}`;
    }

    return {
      status: "success",
      data: item,
      humanOutput,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
