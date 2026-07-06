import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigPaths, type InstallerContext, NodeFilesystem, SystemClock } from "cmx-core";
import { VERSION } from "../constants.ts";
import { type InitCommandOptions, initCommand } from "./init.ts";

interface JsonFileResult {
  path: string;
  action: string;
  warning?: string;
}

interface InitJsonResult {
  success: boolean;
  message: string;
  version: string;
  files: JsonFileResult[];
}

describe("init", () => {
  let tempRoot: string;
  let homeDir: string;
  let projectRoot: string;
  let context: InstallerContext;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hopper-init-"));
    homeDir = join(tempRoot, "home");
    projectRoot = join(tempRoot, "project");
    await mkdir(homeDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    context = {
      fs: new NodeFilesystem(),
      clock: new SystemClock(),
      paths: new ConfigPaths({
        configDir: join(homeDir, ".config", "context-mixer"),
        homeDir,
        platform: "claude",
        projectRoot,
      }),
    };
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function runInitJson(overrides: Partial<InitCommandOptions> = {}): Promise<InitJsonResult> {
    const logs: string[] = [];
    await initCommand(
      {
        jsonOutput: true,
        scope: "global",
        force: false,
        remove: false,
        ...overrides,
      },
      {
        context,
        log: (...args: unknown[]) => logs.push(args.join(" ")),
      },
    );
    return JSON.parse(logs[0] as string) as InitJsonResult;
  }

  async function readInstalledSkill(scope: "global" | "local" = "global"): Promise<string> {
    return readFile(installedSkillPath(scope), "utf8");
  }

  function installedSkillPath(
    scope: "global" | "local" = "global",
    platform: "claude" | "copilot" = "claude",
  ): string {
    const installDir = context.paths.withPlatform(platform).requireInstallDir("skill", scope);
    return join(installDir, "hopper-coordinator", "SKILL.md");
  }

  async function mutateTrackedVersion(
    version: string,
    scope: "global" | "local" = "global",
  ): Promise<void> {
    const lockPath = context.paths.lockPath(scope);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    const entry = lock.packages?.["hopper-coordinator"];
    if (!entry) {
      throw new Error("Missing hopper-coordinator lock entry");
    }
    entry.version = version;
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
  }

  async function createDeprecatedSkillDir(scope: "global" | "local" = "global"): Promise<string> {
    const installDir = context.paths.withPlatform("claude").requireInstallDir("skill", scope);
    const deprecatedDir = join(installDir, "hopper-worker");
    await mkdir(deprecatedDir, { recursive: true });
    await writeFile(join(deprecatedDir, "SKILL.md"), "# Deprecated skill\n");
    return deprecatedDir;
  }

  async function configureManagedPlatforms(platforms: Array<"claude" | "copilot">): Promise<void> {
    const configPath = context.paths.configPath();
    await mkdir(context.paths.configDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ platforms }, null, 2));
  }

  test("installs globally and stamps metadata.version without hopper-version", async () => {
    const result = await runInitJson();

    expect(result.success).toBe(true);
    expect(result.version).toBe(VERSION);
    expect(result.files).toContainEqual({
      path: installedSkillPath(),
      action: "created",
    });

    const content = await readInstalledSkill();
    expect(content).toContain(`version: "${VERSION}"`);
    expect(content).not.toContain("hopper-version:");
  });

  test("second install is idempotent and reports up-to-date", async () => {
    await runInitJson();

    const result = await runInitJson();

    expect(result.success).toBe(true);
    expect(result.files).toContainEqual({
      path: installedSkillPath(),
      action: "up-to-date",
    });
  });

  test("tracked older install updates", async () => {
    await runInitJson();
    await mutateTrackedVersion("0.1.0");

    const result = await runInitJson();

    expect(result.success).toBe(true);
    expect(result.files).toContainEqual({
      path: installedSkillPath(),
      action: "updated",
    });
  });

  test("drifted install skips without force", async () => {
    await runInitJson();
    await writeFile(installedSkillPath(), "---\nname: hopper-coordinator\n---\n# Drifted\n");

    const result = await runInitJson();
    const installedFile = result.files.find((file) => file.path === installedSkillPath());

    expect(result.success).toBe(false);
    expect(installedFile?.action).toBe("skipped");
    expect(installedFile?.warning).toContain("drifted on disk");
  });

  test("newer tracked install refuses without --force", async () => {
    await runInitJson();
    await mutateTrackedVersion("99.0.0");

    const result = await runInitJson();
    const installedFile = result.files.find((file) => file.path === installedSkillPath());

    expect(result.success).toBe(false);
    expect(installedFile?.action).toBe("skipped");
    expect(installedFile?.warning).toContain("v99.0.0");
    expect(installedFile?.warning).toContain("--force");
  });

  test("blocked multi-platform plan reports pending writes as skipped", async () => {
    await configureManagedPlatforms(["claude", "copilot"]);
    await runInitJson();
    await mutateTrackedVersion("99.0.0");
    await rm(join(installedSkillPath("global", "copilot"), ".."), {
      recursive: true,
      force: true,
    });

    const result = await runInitJson();
    const claudeFile = result.files.find((file) => file.path === installedSkillPath());
    const copilotFile = result.files.find(
      (file) => file.path === installedSkillPath("global", "copilot"),
    );

    expect(result.success).toBe(false);
    expect(claudeFile?.action).toBe("skipped");
    expect(claudeFile?.warning).toContain("v99.0.0");
    expect(copilotFile?.action).toBe("skipped");
    expect(copilotFile?.warning).toContain("another platform");
    expect(await Bun.file(installedSkillPath("global", "copilot")).exists()).toBe(false);
  });

  test("force downgrades a newer tracked install", async () => {
    await runInitJson();
    await mutateTrackedVersion("99.0.0");

    const result = await runInitJson({ force: true });
    const installedFile = result.files.find((file) => file.path === installedSkillPath());

    expect(result.success).toBe(true);
    expect(installedFile?.action).toBe("updated");
    expect(installedFile?.warning).toContain("Downgrading skill from v99.0.0");

    const content = await readInstalledSkill();
    expect(content).toContain(`version: "${VERSION}"`);
  });

  test("remove deletes the installed skill directory", async () => {
    await runInitJson();

    const result = await runInitJson({ remove: true });

    expect(result.success).toBe(true);
    expect(result.files).toContainEqual({
      path: join(
        context.paths.withPlatform("claude").requireInstallDir("skill", "global"),
        "hopper-coordinator",
      ),
      action: "removed",
    });
    expect(await Bun.file(installedSkillPath()).exists()).toBe(false);

    const lockPath = context.paths.lockPath("global");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      packages?: Record<string, unknown>;
    };
    expect(lock.packages?.["hopper-coordinator"]).toBeUndefined();
  });

  test("install removes the deprecated hopper-worker directory", async () => {
    const deprecatedDir = await createDeprecatedSkillDir();

    const result = await runInitJson();

    expect(result.files).toContainEqual({
      path: deprecatedDir,
      action: "removed",
    });
    expect(await Bun.file(join(deprecatedDir, "SKILL.md")).exists()).toBe(false);
  });

  test("local scope installs into the project .claude directory", async () => {
    const result = await runInitJson({ scope: "local" });

    expect(result.success).toBe(true);
    expect(result.files).toContainEqual({
      path: installedSkillPath("local"),
      action: "created",
    });

    const content = await readInstalledSkill("local");
    expect(content).toContain(`version: "${VERSION}"`);
  });
});
