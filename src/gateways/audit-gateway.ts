import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A single phase JSONL file for an audit item. */
export interface PhaseFile {
  /** Absolute path to the file. */
  path: string;
  /** Basename of the file, e.g. `<id>-execute-2.jsonl`. */
  name: string;
  /** Last-modified time in milliseconds. */
  mtimeMs: number;
}

export interface AuditGateway {
  /**
   * List every `<itemId>-*.jsonl` file in the audit directory.
   * Returns an empty array when the directory or files are missing.
   */
  listPhaseFiles(itemId: string): Promise<PhaseFile[]>;

  /**
   * Read all JSONL lines and mtime from a file.
   * Returns null when the file is missing or unreadable.
   */
  readJsonlLines(path: string): Promise<{ lines: string[]; mtimeMs: number } | null>;

  /**
   * Read a markdown file as text.
   * Returns null when the file is missing or unreadable.
   */
  readMarkdown(path: string): Promise<string | null>;

  /** Resolve well-known paths for a given item ID. */
  paths(itemId: string): { plan: string; result: string; auditDir: string };
}

export function createAuditGateway(hopperHome?: string): AuditGateway {
  const home = hopperHome ?? join(homedir(), ".hopper");
  const auditDir = join(home, "audit");

  return {
    async listPhaseFiles(itemId: string): Promise<PhaseFile[]> {
      try {
        const entries = await readdir(auditDir, { withFileTypes: true });
        const prefix = `${itemId}-`;
        const suffix = ".jsonl";
        const results: PhaseFile[] = [];

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const name = entry.name;
          if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;

          const filePath = join(auditDir, name);
          const file = Bun.file(filePath);
          const mtimeMs = file.lastModified;

          results.push({ path: filePath, name, mtimeMs });
        }

        return results;
      } catch {
        // Missing directory or unreadable — return empty
        return [];
      }
    },

    async readJsonlLines(path: string): Promise<{ lines: string[]; mtimeMs: number } | null> {
      try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;

        const text = await file.text();
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        return { lines, mtimeMs: file.lastModified };
      } catch {
        return null;
      }
    },

    async readMarkdown(path: string): Promise<string | null> {
      try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        return await file.text();
      } catch {
        return null;
      }
    },

    paths(itemId: string): { plan: string; result: string; auditDir: string } {
      return {
        plan: join(auditDir, `${itemId}-plan.md`),
        result: join(auditDir, `${itemId}-result.md`),
        auditDir,
      };
    },
  };
}
