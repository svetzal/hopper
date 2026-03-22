import type { ParsedArgs } from "../cli.ts";
import type { TitleGenerator } from "../titler.ts";
import { addItem, loadItems } from "../store.ts";
import { findPreset } from "../presets.ts";
import { parsePriority, priorityBadge } from "../priority.ts";
import { shortId } from "../format.ts";
import { normalizeTag, mergeTags } from "../tags.ts";
import { Status } from "../constants.ts";
import {
  validateDirBranch,
  validateTimesSpec,
  resolveScheduling,
  resolveDependencies,
  buildNewItem,
  formatValidationError,
} from "../add-workflow.ts";

export async function addCommand(parsed: ParsedArgs, titler: TitleGenerator): Promise<void> {
  // 1. Resolve preset (I/O)
  const presetName = typeof parsed.flags.preset === "string" ? parsed.flags.preset : undefined;
  let preset;
  if (presetName) {
    preset = await findPreset(presetName);
    if (!preset) {
      console.error(`No preset found with name: ${presetName}`);
      process.exit(1);
    }
  }

  // 2. Get description from args or stdin (I/O)
  let description = parsed.positional[0] ?? "";

  if (!description && !process.stdin.isTTY) {
    description = await new Response(Bun.stdin.stream()).text();
    description = description.trim();
  }

  if (!description && preset) {
    description = preset.description;
  }

  // 3. Validate description exists
  if (!description) {
    console.error(formatValidationError({ code: "MISSING_DESCRIPTION" }));
    process.exit(1);
  }

  // 4. Generate title (I/O)
  const title = await titler.generateTitle(description);

  // 5. Resolve dir/branch/command from args + preset
  const dir = typeof parsed.flags.dir === "string" ? parsed.flags.dir : preset?.workingDir;
  const branch = typeof parsed.flags.branch === "string" ? parsed.flags.branch : preset?.branch;
  const command = typeof parsed.flags.command === "string" ? parsed.flags.command : preset?.command;

  // 6. Validate dir/branch combination
  const dirBranchError = validateDirBranch(dir, branch, command);
  if (dirBranchError) {
    console.error(formatValidationError(dirBranchError));
    process.exit(1);
  }

  // 7. Parse priority
  let priority;
  const priorityFlag = typeof parsed.flags.priority === "string" ? parsed.flags.priority : undefined;
  if (priorityFlag) {
    try {
      priority = parsePriority(priorityFlag);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  // 8. Validate --times spec
  const everySpec = typeof parsed.flags.every === "string" ? parsed.flags.every : undefined;
  const timesSpec = typeof parsed.flags.times === "string" ? parsed.flags.times : undefined;
  const timesResult = validateTimesSpec(timesSpec, everySpec);
  if ("error" in timesResult) {
    console.error(formatValidationError(timesResult.error));
    process.exit(1);
  }

  // 9. Resolve scheduling
  const afterSpec = typeof parsed.flags.after === "string" ? parsed.flags.after : undefined;
  const untilSpec = typeof parsed.flags.until === "string" ? parsed.flags.until : undefined;
  const schedulingResult = resolveScheduling(everySpec, afterSpec, untilSpec, timesResult.value, new Date());
  if ("error" in schedulingResult) {
    console.error(formatValidationError(schedulingResult.error));
    process.exit(1);
  }

  // 10. Normalize tags
  const rawTags = parsed.arrayFlags["tag"] ?? [];
  let tags: string[] | undefined;
  if (rawTags.length > 0 || preset?.tags?.length) {
    try {
      const normalizedFlags = rawTags.map(normalizeTag);
      const presetTags = preset?.tags ?? [];
      tags = mergeTags(presetTags, normalizedFlags);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  // 11. Resolve dependencies (I/O)
  const afterItemIds = parsed.arrayFlags["after-item"] ?? [];
  let dependsOn: string[] | undefined;
  let itemStatus = schedulingResult.status;

  if (afterItemIds.length > 0) {
    const allItems = await loadItems();
    const depResult = resolveDependencies(afterItemIds, allItems);
    if (!depResult.ok) {
      console.error(formatValidationError(depResult.error));
      process.exit(1);
    }
    for (const warning of depResult.warnings) {
      console.warn(warning);
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

  // 14. Print output (I/O)
  if (parsed.flags.json === true) {
    console.log(JSON.stringify(item, null, 2));
  } else {
    const presetSuffix = preset ? ` (from preset: ${preset.name})` : "";
    const pBadge = priorityBadge(priority);
    const tagBadge = tags?.length ? ` [${tags.join(", ")}]` : "";
    if (dependsOn) {
      const depBadge = dependsOn.map(id => shortId(id)).join(", ");
      console.log(`Added: ${title}${pBadge}${tagBadge} (blocked on: ${depBadge})${presetSuffix}`);
    } else if (schedulingResult.recurrence) {
      console.log(`Added: ${title}${pBadge}${tagBadge} (recurring every ${schedulingResult.recurrence.interval}, next run: ${new Date(schedulingResult.scheduledAt!).toLocaleString()})${presetSuffix}`);
    } else if (schedulingResult.scheduledAt) {
      console.log(`Added: ${title}${pBadge}${tagBadge} (scheduled for ${new Date(schedulingResult.scheduledAt).toLocaleString()})${presetSuffix}`);
    } else {
      console.log(`Added: ${title}${pBadge}${tagBadge}${presetSuffix}`);
    }
  }
}
