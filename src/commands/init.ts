import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Embed skill files at build time via Bun text imports
// Source of truth lives in skills/ — .claude/skills/ is the installed copy
import COORDINATOR_SKILL_MD from "../../skills/hopper-coordinator/SKILL.md" with { type: "text" };
import WORKER_SKILL_MD from "../../skills/hopper-worker/SKILL.md" with { type: "text" };

const VERSION = "0.2.1";
const VERSION_HEADER = `<!-- hopper v${VERSION} -->\n`;

interface SkillFile {
  relativePath: string;
  content: string;
}

const SKILL_FILES: SkillFile[] = [
  { relativePath: ".claude/skills/hopper-coordinator/SKILL.md", content: COORDINATOR_SKILL_MD },
  { relativePath: ".claude/skills/hopper-worker/SKILL.md", content: WORKER_SKILL_MD },
];

type FileAction = "created" | "updated" | "up-to-date";

interface FileResult {
  path: string;
  action: FileAction;
}

interface InitResult {
  success: boolean;
  message: string;
  version: string;
  files: FileResult[];
}

function stripVersionHeader(content: string): string {
  if (content.startsWith("<!-- hopper v")) {
    const newlineIndex = content.indexOf("\n");
    if (newlineIndex !== -1) {
      return content.slice(newlineIndex + 1);
    }
  }
  return content;
}

export async function initCommand(jsonOutput: boolean): Promise<void> {
  const cwd = process.cwd();
  const results: FileResult[] = [];

  for (const file of SKILL_FILES) {
    const fullPath = join(cwd, file.relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    const stamped = VERSION_HEADER + file.content;

    let action: FileAction;

    if (!existsSync(fullPath)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, stamped, "utf-8");
      action = "created";
    } else {
      const existing = readFileSync(fullPath, "utf-8");
      const existingBody = stripVersionHeader(existing);
      const newBody = file.content;

      if (existingBody === newBody) {
        if (existing !== stamped) {
          writeFileSync(fullPath, stamped, "utf-8");
        }
        action = "up-to-date";
      } else {
        writeFileSync(fullPath, stamped, "utf-8");
        action = "updated";
      }
    }

    results.push({ path: file.relativePath, action });
  }

  const created = results.filter(r => r.action === "created").length;
  const updated = results.filter(r => r.action === "updated").length;
  const upToDate = results.filter(r => r.action === "up-to-date").length;

  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (upToDate > 0) parts.push(`${upToDate} up to date`);
  const summary = parts.join(", ");

  if (jsonOutput) {
    const output: InitResult = {
      success: true,
      message: `Skill files installed: ${summary}`,
      version: VERSION,
      files: results,
    };
    console.log(JSON.stringify(output));
  } else {
    console.log(`\nHopper v${VERSION} — skill files\n`);
    for (const r of results) {
      const icon =
        r.action === "created" ? "+" :
        r.action === "updated" ? "~" :
        "=";
      const label =
        r.action === "created" ? "Created" :
        r.action === "updated" ? "Updated" :
        "Up to date";
      console.log(`  ${icon} ${r.path} (${label})`);
    }
    console.log(`\n${summary}`);
  }
}
