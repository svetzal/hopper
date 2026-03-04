import type { ParsedArgs } from "../cli.ts";
import type { TitleGenerator } from "../titler.ts";
import { addItem } from "../store.ts";
import { Status } from "../constants.ts";

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

  const item = {
    id: crypto.randomUUID(),
    title,
    description,
    status: Status.QUEUED,
    createdAt: new Date().toISOString(),
    ...(dir ? { workingDir: dir } : {}),
    ...(branch ? { branch } : {}),
  };

  await addItem(item);

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(item, null, 2));
  } else {
    console.log(`Added: ${title}`);
  }
}
