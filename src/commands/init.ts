import { mkdir } from "fs/promises";
import { join } from "path";
import { VERSION } from "../cli.ts";

// Embed skill files at build time via Bun text imports
// Source of truth lives in skills/ — .claude/skills/ is the installed copy
import COORDINATOR_SKILL_MD from "../../skills/hopper-coordinator/SKILL.md" with { type: "text" };
import WORKER_SKILL_MD from "../../skills/hopper-worker/SKILL.md" with { type: "text" };

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

function stampVersion(content: string): string {
  const closingIndex = content.indexOf("\n---", 1);
  if (closingIndex === -1) return content;
  return content.slice(0, closingIndex) + `\nhopper-version: ${VERSION}` + content.slice(closingIndex);
}

function stripVersionInfo(content: string): string {
  // Old format: HTML comment on first line
  if (content.startsWith("<!-- hopper v")) {
    const newlineIndex = content.indexOf("\n");
    if (newlineIndex !== -1) {
      content = content.slice(newlineIndex + 1);
    }
  }
  // New format: hopper-version field in front-matter
  return content.replace(/\nhopper-version: .+/g, "");
}

export async function initCommand(jsonOutput: boolean): Promise<void> {
  const cwd = process.cwd();
  const results: FileResult[] = [];

  for (const file of SKILL_FILES) {
    const fullPath = join(cwd, file.relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    const stamped = stampVersion(file.content);

    let action: FileAction;
    const fileRef = Bun.file(fullPath);

    if (!(await fileRef.exists())) {
      await mkdir(dir, { recursive: true });
      await Bun.write(fullPath, stamped);
      action = "created";
    } else {
      const existing = await fileRef.text();
      const existingBody = stripVersionInfo(existing);
      const newBody = file.content;

      if (existingBody === newBody) {
        if (existing !== stamped) {
          await Bun.write(fullPath, stamped);
        }
        action = "up-to-date";
      } else {
        await Bun.write(fullPath, stamped);
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
