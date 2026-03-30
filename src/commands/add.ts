import {
  buildNewItem,
  formatValidationError,
  resolveDependencies,
  resolveScheduling,
  validateDirBranch,
  validateTimesSpec,
} from "../add-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { Status } from "../constants.ts";
import { toErrorMessage } from "../error-utils.ts";
import { shortId } from "../format.ts";
import { findPreset } from "../presets.ts";
import type { Priority } from "../priority.ts";
import { parsePriority, priorityBadge } from "../priority.ts";
import { addItem, loadItems } from "../store.ts";
import { mergeTags, normalizeTags, tagBadge } from "../tags.ts";
import type { TitleGenerator } from "../titler.ts";

export async function addCommand(
  parsed: ParsedArgs,
  titler: TitleGenerator,
  readStdin: () => Promise<string> = () => new Response(Bun.stdin.stream()).text(),
): Promise<CommandResult> {
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

  // 6. Validate dir/branch combination
  const dirBranchError = validateDirBranch(dir, branch, command);
  if (dirBranchError) {
    return { status: "error", message: formatValidationError(dirBranchError) };
  }

  // 7. Parse priority
  let priority: Priority | undefined;
  const priorityFlag = stringFlag(parsed, "priority");
  if (priorityFlag) {
    try {
      priority = parsePriority(priorityFlag);
    } catch (e) {
      return { status: "error", message: toErrorMessage(e) };
    }
  }

  // 8. Validate --times spec
  const everySpec = stringFlag(parsed, "every");
  const timesSpec = stringFlag(parsed, "times");
  const timesResult = validateTimesSpec(timesSpec, everySpec);
  if ("error" in timesResult) {
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
  if ("error" in schedulingResult) {
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
    tags = mergeTags(presetTags, tagResult.tags);
  }

  // 11. Resolve dependencies (I/O)
  const afterItemIds = parsed.arrayFlags["after-item"] ?? [];
  let dependsOn: string[] | undefined;
  let itemStatus = schedulingResult.status;

  if (afterItemIds.length > 0) {
    const allItems = await loadItems();
    const depResult = resolveDependencies(afterItemIds, allItems);
    if (!depResult.ok) {
      return { status: "error", message: formatValidationError(depResult.error) };
    }
    for (const warning of depResult.warnings) {
      warnings.push(warning);
    }
    dependsOn = depResult.resolvedIds;
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
    scheduledAt: schedulingResult.scheduledAt,
    dir,
    branch,
    command,
    recurrence: schedulingResult.recurrence,
    dependsOn,
    tags,
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
  } else if (schedulingResult.recurrence) {
    humanOutput = `Added: ${title}${pBadge}${tBadge} (recurring every ${schedulingResult.recurrence.interval}, next run: ${schedulingResult.scheduledAt ? new Date(schedulingResult.scheduledAt).toLocaleString() : "unknown"})${presetSuffix}`;
  } else if (schedulingResult.scheduledAt) {
    humanOutput = `Added: ${title}${pBadge}${tBadge} (scheduled for ${new Date(schedulingResult.scheduledAt).toLocaleString()})${presetSuffix}`;
  } else {
    humanOutput = `Added: ${title}${pBadge}${tBadge}${presetSuffix}`;
  }

  return {
    status: "success",
    data: item,
    humanOutput,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
