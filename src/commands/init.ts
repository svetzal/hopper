import { mkdir, rm } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { VERSION } from "../constants.ts";

// Embed skill files at build time via Bun text imports
// Source of truth lives in skills/ — .claude/skills/ is the installed copy
import COORDINATOR_SKILL_MD from "../../skills/hopper-coordinator/SKILL.md" with { type: "text" };

interface SkillFile {
  relativePath: string;
  content: string;
}

const SKILL_FILES: SkillFile[] = [
  { relativePath: ".claude/skills/hopper-coordinator/SKILL.md", content: COORDINATOR_SKILL_MD },
];

// Skills removed in previous versions — clean up if present
const DEPRECATED_SKILL_DIRS: string[] = [
  ".claude/skills/hopper-worker",
];

type FileAction = "created" | "updated" | "up-to-date" | "removed";

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

export async function initCommand(jsonOutput: boolean, global: boolean = false): Promise<void> {
  const baseDir = global ? join(homedir(), ".claude") : process.cwd();
  const results: FileResult[] = [];

  for (const file of SKILL_FILES) {
    const relPath = global ? file.relativePath.replace(/^\.claude\//, "") : file.relativePath;
    const fullPath = join(baseDir, relPath);
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

    results.push({ path: relPath, action });
  }

  // Remove deprecated skills
  for (const relDir of DEPRECATED_SKILL_DIRS) {
    const relPath = global ? relDir.replace(/^\.claude\//, "") : relDir;
    const fullPath = join(baseDir, relPath);
    const marker = Bun.file(join(fullPath, "SKILL.md"));
    if (await marker.exists()) {
      await rm(fullPath, { recursive: true });
      results.push({ path: relPath, action: "removed" });
    }
  }

  const created = results.filter(r => r.action === "created").length;
  const updated = results.filter(r => r.action === "updated").length;
  const upToDate = results.filter(r => r.action === "up-to-date").length;
  const removed = results.filter(r => r.action === "removed").length;

  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (upToDate > 0) parts.push(`${upToDate} up to date`);
  if (removed > 0) parts.push(`${removed} removed`);
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
    const scope = global ? "global (~/.claude)" : "local";
    console.log(`\nHopper v${VERSION} — skill files (${scope})\n`);
    for (const r of results) {
      const icon =
        r.action === "created" ? "+" :
        r.action === "updated" ? "~" :
        r.action === "removed" ? "-" :
        "=";
      const label =
        r.action === "created" ? "Created" :
        r.action === "updated" ? "Updated" :
        r.action === "removed" ? "Removed" :
        "Up to date";
      console.log(`  ${icon} ${r.path} (${label})`);
    }
    console.log(`\n${summary}`);
  }
}
