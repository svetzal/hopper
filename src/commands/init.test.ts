import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../constants.ts";
import { compareSemver, parseInstalledVersion } from "./init.ts";

describe("init", () => {
  describe("compareSemver", () => {
    test("equal versions return 0", () => {
      expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
    });

    test("first is newer returns 1", () => {
      expect(compareSemver("1.3.0", "1.2.0")).toBe(1);
    });

    test("first is older returns -1", () => {
      expect(compareSemver("1.2.0", "1.3.0")).toBe(-1);
    });

    test("compares major version", () => {
      expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    });

    test("compares patch version", () => {
      expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    });
  });

  describe("parseInstalledVersion", () => {
    test("extracts version from frontmatter", () => {
      const content = "---\nname: test\nhopper-version: 1.3.0\n---\n# Skill";
      expect(parseInstalledVersion(content)).toBe("1.3.0");
    });

    test("returns null when no version field", () => {
      const content = "---\nname: test\n---\n# Skill";
      expect(parseInstalledVersion(content)).toBeNull();
    });

    test("returns null for plain content", () => {
      expect(parseInstalledVersion("# Just a markdown file")).toBeNull();
    });
  });

  describe("version guard (integration)", () => {
    let tmpDir: string;
    const skillRelPath = ".claude/skills/hopper-coordinator/SKILL.md";

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "hopper-init-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true });
    });

    async function writeSkill(content: string) {
      const fullPath = join(tmpDir, skillRelPath);
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      await Bun.spawn(["mkdir", "-p", dir]).exited;
      await Bun.write(fullPath, content);
    }

    async function readSkill(): Promise<string | null> {
      const fullPath = join(tmpDir, skillRelPath);
      const f = Bun.file(fullPath);
      if (!(await f.exists())) return null;
      return f.text();
    }

    function makeFrontmatter(version?: string): string {
      const versionLine = version ? `\nhopper-version: ${version}` : "";
      return `---\nname: hopper-coordinator\ndescription: Test skill${versionLine}\n---\n\n# Test Skill\n\nSome content.`;
    }

    // We need to call initCommand with the tmpDir as cwd
    // Since initCommand uses process.cwd(), we'll temporarily change it
    async function runInit(force: boolean = false): Promise<string> {
      const originalCwd = process.cwd();
      process.chdir(tmpDir);
      // Capture console output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        const { initCommand } = await import("./init.ts");
        await initCommand(false, false, force);
      } finally {
        process.chdir(originalCwd);
        console.log = originalLog;
      }
      return logs.join("\n");
    }

    async function runInitJson(
      force: boolean = false,
    ): Promise<{ success: boolean; files: Array<{ action: string; warning?: string }> }> {
      const originalCwd = process.cwd();
      process.chdir(tmpDir);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        const { initCommand } = await import("./init.ts");
        await initCommand(true, false, force);
      } finally {
        process.chdir(originalCwd);
        console.log = originalLog;
      }
      return JSON.parse(logs[0] as string);
    }

    test("no installed file → create", async () => {
      const result = await runInitJson();
      expect(result.success).toBe(true);
      expect(result.files[0]?.action).toBe("created");
      const content = await readSkill();
      expect(content).toContain(`hopper-version: ${VERSION}`);
    });

    test("no version in installed file → overwrite", async () => {
      await writeSkill(makeFrontmatter());
      const result = await runInitJson();
      expect(result.success).toBe(true);
      expect(result.files[0]?.action).toBe("updated");
    });

    test("installed version older than binary → overwrite", async () => {
      await writeSkill(makeFrontmatter("0.1.0"));
      const result = await runInitJson();
      expect(result.success).toBe(true);
      expect(result.files[0]?.action).toBe("updated");
    });

    test("installed version same as binary → up-to-date or updated", async () => {
      // Install first to get the correct content
      await runInit();
      // Run again — should be up-to-date
      const result = await runInitJson();
      expect(result.success).toBe(true);
      expect(result.files[0]?.action).toBe("up-to-date");
    });

    test("installed version newer than binary → refuse without --force", async () => {
      await writeSkill(makeFrontmatter("99.0.0"));
      const result = await runInitJson();
      expect(result.success).toBe(false);
      expect(result.files[0]?.action).toBe("skipped");
      expect(result.files[0]?.warning).toContain("v99.0.0");
      expect(result.files[0]?.warning).toContain("--force");
      // File should be unchanged
      const content = await readSkill();
      expect(content).toContain("hopper-version: 99.0.0");
    });

    test("installed version newer + --force → overwrite with warning", async () => {
      await writeSkill(makeFrontmatter("99.0.0"));
      const result = await runInitJson(true);
      expect(result.success).toBe(true);
      expect(result.files[0]?.action).toBe("updated");
      expect(result.files[0]?.warning).toContain("Downgrading");
      // File should now have current version
      const content = await readSkill();
      expect(content).toContain(`hopper-version: ${VERSION}`);
    });
  });
});
