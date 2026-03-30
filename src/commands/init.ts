import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// Embed skill files at build time via Bun text imports
// Source of truth lives in skills/ — .claude/skills/ is the installed copy
import COORDINATOR_SKILL_MD from "../../skills/hopper-coordinator/SKILL.md" with { type: "text" };
import { VERSION } from "../constants.ts";

interface SkillFile {
  relativePath: string;
  content: string;
}

const SKILL_FILES: SkillFile[] = [
  { relativePath: ".claude/skills/hopper-coordinator/SKILL.md", content: COORDINATOR_SKILL_MD },
];

// Skills removed in previous versions — clean up if present
const DEPRECATED_SKILL_DIRS: string[] = [".claude/skills/hopper-worker"];

type FileAction = "created" | "updated" | "up-to-date" | "removed" | "skipped";

const ACTION_META: Record<FileAction, { icon: string; label: string }> = {
  created: { icon: "+", label: "Created" },
  updated: { icon: "~", label: "Updated" },
  "up-to-date": { icon: "=", label: "Up to date" },
  removed: { icon: "-", label: "Removed" },
  skipped: { icon: "!", label: "Skipped" },
};

interface FileResult {
  path: string;
  action: FileAction;
  warning?: string;
}

interface InitResult {
  success: boolean;
  message: string;
  version: string;
  files: FileResult[];
}

export function stampVersion(content: string): string {
  const closingIndex = content.indexOf("\n---", 1);
  if (closingIndex === -1) return content;
  // Update metadata.version to match binary version
  let frontmatter = content.slice(0, closingIndex);
  frontmatter = frontmatter.replace(/(\n {2}version: )"[^"]*"/, `$1"${VERSION}"`);
  // Stamp hopper-version for backwards compatibility
  return `${frontmatter}\nhopper-version: ${VERSION}${content.slice(closingIndex)}`;
}

export function stripVersionInfo(content: string): string {
  // Old format: HTML comment on first line
  if (content.startsWith("<!-- hopper v")) {
    const newlineIndex = content.indexOf("\n");
    if (newlineIndex !== -1) {
      content = content.slice(newlineIndex + 1);
    }
  }
  // Strip hopper-version field in front-matter
  content = content.replace(/\nhopper-version: .+/g, "");
  // Strip metadata.version value (replace with source placeholder)
  content = content.replace(/(\n {2}version: )"[^"]*"/, '$1"0.0.0"');
  return content;
}

export function parseInstalledVersion(content: string): string | null {
  const match = content.match(/\nhopper-version:\s*(.+)/);
  return match ? (match[1]?.trim() ?? null) : null;
}

/** Compare two semver strings. Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

export async function initCommand(
  jsonOutput: boolean,
  global: boolean = false,
  force: boolean = false,
): Promise<void> {
  const baseDir = global ? join(homedir(), ".claude") : process.cwd();
  const results: FileResult[] = [];

  for (const file of SKILL_FILES) {
    const relPath = global ? file.relativePath.replace(/^\.claude\//, "") : file.relativePath;
    const fullPath = join(baseDir, relPath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    const stamped = stampVersion(file.content);

    let action: FileAction;
    let warning: string | undefined;
    const fileRef = Bun.file(fullPath);

    if (!(await fileRef.exists())) {
      await mkdir(dir, { recursive: true });
      await Bun.write(fullPath, stamped);
      action = "created";
    } else {
      const existing = await fileRef.text();

      // Version guard: refuse to overwrite a newer installed skill
      const installedVersion = parseInstalledVersion(existing);
      if (installedVersion && compareSemver(installedVersion, VERSION) > 0) {
        if (!force) {
          warning = `Installed skill is from hopper v${installedVersion} but this binary is v${VERSION}. Use --force to downgrade.`;
          action = "skipped";
          results.push({ path: relPath, action, warning });
          continue;
        }
        warning = `Downgrading skill from v${installedVersion} to v${VERSION} (--force)`;
      }

      const existingBody = stripVersionInfo(existing);
      const newBody = stripVersionInfo(file.content);

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

    results.push({ path: relPath, action, warning });
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

  const counts = results.reduce(
    (acc, r) => {
      acc[r.action] = (acc[r.action] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<FileAction, number>>,
  );
  const created = counts.created ?? 0;
  const updated = counts.updated ?? 0;
  const upToDate = counts["up-to-date"] ?? 0;
  const removed = counts.removed ?? 0;
  const skipped = counts.skipped ?? 0;

  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (upToDate > 0) parts.push(`${upToDate} up to date`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const summary = parts.join(", ");

  if (jsonOutput) {
    const output: InitResult = {
      success: skipped === 0,
      message:
        skipped > 0 ? `Skill files skipped: ${summary}` : `Skill files installed: ${summary}`,
      version: VERSION,
      files: results,
    };
    console.log(JSON.stringify(output));
  } else {
    const scope = global ? "global (~/.claude)" : "local";
    console.log(`\nHopper v${VERSION} — skill files (${scope})\n`);
    for (const r of results) {
      const { icon, label } = ACTION_META[r.action];
      console.log(`  ${icon} ${r.path} (${label})`);
      if (r.warning) {
        console.log(`    ${r.warning}`);
      }
    }
    console.log(`\n${summary}`);
  }
}
