import type { ParsedArgs } from "../cli.ts";
import type { TitleGenerator } from "../titler.ts";
import { addItem } from "../store.ts";
import { Status } from "../constants.ts";
import type { ItemStatus } from "../constants.ts";
import { parseTimeSpec } from "../parse-time.ts";

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
  let scheduledAt: string | undefined;
  let status: ItemStatus = Status.QUEUED;

  if (afterSpec) {
    const scheduledDate = parseTimeSpec(afterSpec);
    scheduledAt = scheduledDate.toISOString();
    status = Status.SCHEDULED;
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
  };

  await addItem(item);

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(item, null, 2));
  } else if (scheduledAt) {
    console.log(`Added: ${title} (scheduled for ${new Date(scheduledAt).toLocaleString()})`);
  } else {
    console.log(`Added: ${title}`);
  }
}
