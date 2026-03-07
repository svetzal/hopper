import type { ParsedArgs } from "../cli.ts";
import type { TitleGenerator } from "../titler.ts";
import { addItem, loadItems } from "../store.ts";
import { Status } from "../constants.ts";
import type { ItemStatus } from "../constants.ts";
import { parseTimeSpec, parseDuration } from "../parse-time.ts";
import { findPreset } from "../presets.ts";
import { parsePriority, priorityBadge } from "../priority.ts";
import type { Priority } from "../priority.ts";
import { shortId } from "../format.ts";

export async function addCommand(parsed: ParsedArgs, titler: TitleGenerator): Promise<void> {
  const presetName = typeof parsed.flags.preset === "string" ? parsed.flags.preset : undefined;
  let preset;
  if (presetName) {
    preset = await findPreset(presetName);
    if (!preset) {
      console.error(`No preset found with name: ${presetName}`);
      process.exit(1);
    }
  }

  let description = parsed.positional[0] ?? "";

  if (!description && !process.stdin.isTTY) {
    description = await new Response(Bun.stdin.stream()).text();
    description = description.trim();
  }

  if (!description && preset) {
    description = preset.description;
  }

  if (!description) {
    console.error("Usage: hopper add <description>");
    console.error('  or:  echo "description" | hopper add');
    process.exit(1);
  }

  const title = await titler.generateTitle(description);

  const dir = typeof parsed.flags.dir === "string" ? parsed.flags.dir : preset?.workingDir;
  const branch = typeof parsed.flags.branch === "string" ? parsed.flags.branch : preset?.branch;

  if (dir && !branch) {
    console.error("Error: --branch is required when --dir is set");
    process.exit(1);
  }
  if (branch && !dir) {
    console.error("Error: --branch requires --dir");
    process.exit(1);
  }

  let priority: Priority | undefined;
  const priorityFlag = typeof parsed.flags.priority === "string" ? parsed.flags.priority : undefined;
  if (priorityFlag) {
    try {
      priority = parsePriority(priorityFlag);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  const afterSpec = typeof parsed.flags.after === "string" ? parsed.flags.after : undefined;
  const everySpec = typeof parsed.flags.every === "string" ? parsed.flags.every : undefined;
  const untilSpec = typeof parsed.flags.until === "string" ? parsed.flags.until : undefined;

  let scheduledAt: string | undefined;
  let status: ItemStatus = Status.QUEUED;
  let recurrence: { interval: string; intervalMs: number; until?: string } | undefined;

  if (everySpec) {
    let intervalMs: number;
    try {
      intervalMs = parseDuration(everySpec);
    } catch {
      console.error(`Error: --every requires a relative duration (e.g. 4h, 30m, 1d), got "${everySpec}"`);
      process.exit(1);
    }

    const MIN_INTERVAL_MS = 5 * 60_000; // 5 minutes
    if (intervalMs < MIN_INTERVAL_MS) {
      console.error("Error: minimum recurrence interval is 5 minutes");
      process.exit(1);
    }

    if (afterSpec) {
      scheduledAt = parseTimeSpec(afterSpec).toISOString();
    } else {
      scheduledAt = new Date(Date.now() + intervalMs).toISOString();
    }
    status = Status.SCHEDULED;

    recurrence = { interval: everySpec, intervalMs };

    if (untilSpec) {
      const untilDate = parseTimeSpec(untilSpec);
      if (untilDate.getTime() <= new Date(scheduledAt).getTime()) {
        console.error("Error: --until must be after the scheduled start time");
        process.exit(1);
      }
      recurrence.until = untilDate.toISOString();
    }
  } else if (afterSpec) {
    scheduledAt = parseTimeSpec(afterSpec).toISOString();
    status = Status.SCHEDULED;
  }

  if (untilSpec && !everySpec) {
    console.error("Error: --until requires --every");
    process.exit(1);
  }

  // Handle --after-item / --depends-on (repeatable)
  const afterItemIds = parsed.arrayFlags["after-item"] ?? [];
  let dependsOn: string[] | undefined;

  if (afterItemIds.length > 0) {
    const allItems = await loadItems();
    const resolvedIds: string[] = [];

    for (const idPrefix of afterItemIds) {
      const matches = allItems.filter((i) => i.id === idPrefix || i.id.startsWith(idPrefix));
      if (matches.length === 0) {
        console.error(`No item found with id: ${idPrefix}`);
        process.exit(1);
      }
      if (matches.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}" matches ${matches.length} items. Use a longer prefix.`);
        process.exit(1);
      }
      const dep = matches[0]!;
      if (dep.status === Status.COMPLETED) {
        console.warn(`Warning: dependency ${shortId(dep.id)} is already completed`);
      }
      resolvedIds.push(dep.id);
    }

    // Check for circular dependencies among the specified deps
    detectCycle(resolvedIds, allItems);

    dependsOn = resolvedIds;
    status = Status.BLOCKED;
  }

  const item = {
    id: crypto.randomUUID(),
    title,
    description,
    status,
    createdAt: new Date().toISOString(),
    ...(priority && priority !== 'normal' ? { priority } : {}),
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(dir ? { workingDir: dir } : {}),
    ...(branch ? { branch } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(dependsOn ? { dependsOn } : {}),
  };

  await addItem(item);

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(item, null, 2));
  } else {
    const presetSuffix = preset ? ` (from preset: ${preset.name})` : "";
    const pBadge = priorityBadge(priority);
    if (dependsOn) {
      const depBadge = dependsOn.map(id => shortId(id)).join(", ");
      console.log(`Added: ${title}${pBadge} (blocked on: ${depBadge})${presetSuffix}`);
    } else if (recurrence) {
      console.log(`Added: ${title}${pBadge} (recurring every ${recurrence.interval}, next run: ${new Date(scheduledAt!).toLocaleString()})${presetSuffix}`);
    } else if (scheduledAt) {
      console.log(`Added: ${title}${pBadge} (scheduled for ${new Date(scheduledAt).toLocaleString()})${presetSuffix}`);
    } else {
      console.log(`Added: ${title}${pBadge}${presetSuffix}`);
    }
  }
}

function detectCycle(depIds: string[], allItems: import("../store.ts").Item[]): void {
  const depSet = new Set(depIds);

  for (const startId of depIds) {
    const visited = new Set<string>();
    const stack = [startId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const item = allItems.find((i) => i.id === current);
      if (!item?.dependsOn) continue;

      for (const parentId of item.dependsOn) {
        if (depSet.has(parentId)) {
          // A dependency of our deps leads back to another of our deps — cycle
          console.error(`Circular dependency detected`);
          process.exit(1);
        }
        stack.push(parentId);
      }
    }
  }
}
