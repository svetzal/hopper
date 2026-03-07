import type { ParsedArgs } from "../cli.ts";
import type { TitleGenerator } from "../titler.ts";
import { addItem } from "../store.ts";
import { Status } from "../constants.ts";
import type { ItemStatus } from "../constants.ts";
import { parseTimeSpec, parseDuration } from "../parse-time.ts";

export async function addCommand(parsed: ParsedArgs, titler: TitleGenerator): Promise<void> {
  let description = parsed.positional[0] ?? "";

  if (!description && !process.stdin.isTTY) {
    description = await new Response(Bun.stdin.stream()).text();
    description = description.trim();
  }

  if (!description) {
    console.error("Usage: hopper add <description>");
    console.error('  or:  echo "description" | hopper add');
    process.exit(1);
  }

  const title = await titler.generateTitle(description);

  const dir = typeof parsed.flags.dir === "string" ? parsed.flags.dir : undefined;
  const branch = typeof parsed.flags.branch === "string" ? parsed.flags.branch : undefined;

  if (dir && !branch) {
    console.error("Error: --branch is required when --dir is set");
    process.exit(1);
  }
  if (branch && !dir) {
    console.error("Error: --branch requires --dir");
    process.exit(1);
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

  const item = {
    id: crypto.randomUUID(),
    title,
    description,
    status,
    createdAt: new Date().toISOString(),
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(dir ? { workingDir: dir } : {}),
    ...(branch ? { branch } : {}),
    ...(recurrence ? { recurrence } : {}),
  };

  await addItem(item);

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(item, null, 2));
  } else if (recurrence) {
    console.log(`Added: ${title} (recurring every ${recurrence.interval}, next run: ${new Date(scheduledAt!).toLocaleString()})`);
  } else if (scheduledAt) {
    console.log(`Added: ${title} (scheduled for ${new Date(scheduledAt).toLocaleString()})`);
  } else {
    console.log(`Added: ${title}`);
  }
}
