import { join } from "node:path";
import {
  BundledSkill,
  ConfigPaths,
  type InstallerContext,
  NodeFilesystem,
  type Scope,
  SkillInstaller,
  type Status,
  SystemClock,
  type TargetAction,
  type TargetStatus,
  ToolIdentity,
} from "cmx-core";
import COORDINATOR_SKILL_MD from "../../skills/hopper-coordinator/SKILL.md" with { type: "text" };
import { VERSION } from "../constants.ts";

type FileAction = "created" | "updated" | "up-to-date" | "removed" | "skipped";

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

export interface InitCommandOptions {
  jsonOutput: boolean;
  scope?: Scope;
  force?: boolean;
  remove?: boolean;
}

interface InitDeps {
  context?: InstallerContext;
  installer?: SkillInstaller;
  log?: (...args: unknown[]) => void;
}

const TOOL_NAME = "hopper-coordinator";
const DEPRECATED_CLAUDE_SKILL = "hopper-worker";
const DEPRECATED_CLAUDE_PLATFORM = "claude";
const skill = BundledSkill.singleMd(COORDINATOR_SKILL_MD);

function createInstaller(): SkillInstaller {
  return new SkillInstaller(new ToolIdentity(TOOL_NAME, VERSION));
}

function createContext(): InstallerContext {
  return {
    fs: new NodeFilesystem(),
    clock: new SystemClock(),
    paths: ConfigPaths.fromEnv(DEPRECATED_CLAUDE_PLATFORM),
  };
}

function mapInstallAction(action: TargetAction, wasInstalled: boolean): FileAction {
  switch (action.kind) {
    case "install":
      return wasInstalled ? "updated" : "created";
    case "update":
    case "downgrade":
      return "updated";
    case "skip":
      return "up-to-date";
    case "drifted-skip":
    case "refuse-newer":
      return "skipped";
  }
}

function writesDuringApply(action: TargetAction): boolean {
  switch (action.kind) {
    case "install":
    case "update":
    case "downgrade":
      return true;
    case "skip":
    case "drifted-skip":
    case "refuse-newer":
      return false;
  }
}

function blockedPlanWarning(): string {
  return "Install was blocked by a newer managed skill on another platform. Use --force to apply pending changes.";
}

function actionWarning(action: TargetAction): string | undefined {
  switch (action.kind) {
    case "drifted-skip":
      return `Installed skill v${action.installed} has drifted on disk. Use --force to overwrite local changes.`;
    case "refuse-newer":
      return `Installed skill is from hopper v${action.installed} but this binary is v${VERSION}. Use --force to downgrade.`;
    case "downgrade":
      return `Downgrading skill from v${action.from} to v${VERSION} (--force).`;
    default:
      return undefined;
  }
}

function statusByPlatform(status: Status): Map<string, TargetStatus> {
  return new Map(status.targets.map((target) => [target.platform, target]));
}

function summarize(results: FileResult[]): string {
  const counts = results.reduce(
    (acc, result) => {
      acc[result.action] = (acc[result.action] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<FileAction, number>>,
  );
  const parts: string[] = [];
  if ((counts.created ?? 0) > 0) parts.push(`${counts.created} created`);
  if ((counts.updated ?? 0) > 0) parts.push(`${counts.updated} updated`);
  if ((counts["up-to-date"] ?? 0) > 0) parts.push(`${counts["up-to-date"]} up to date`);
  if ((counts.removed ?? 0) > 0) parts.push(`${counts.removed} removed`);
  if ((counts.skipped ?? 0) > 0) parts.push(`${counts.skipped} skipped`);
  return parts.join(", ") || "no changes";
}

async function cleanupDeprecatedClaudeSkill(
  scope: Scope,
  context: InstallerContext,
): Promise<FileResult[]> {
  const installDir = context.paths
    .withPlatform(DEPRECATED_CLAUDE_PLATFORM)
    .requireInstallDir("skill", scope);
  const deprecatedDir = join(installDir, DEPRECATED_CLAUDE_SKILL);
  const markerPath = join(deprecatedDir, "SKILL.md");

  if (!(await context.fs.exists(markerPath))) {
    return [];
  }

  await context.fs.removeDirAll(deprecatedDir);
  return [{ path: deprecatedDir, action: "removed" }];
}

async function buildInstallResults(
  scope: Scope,
  force: boolean,
  context: InstallerContext,
  installer: SkillInstaller,
): Promise<FileResult[]> {
  const beforeStatus = await installer.status(scope, context);
  const beforeByPlatform = statusByPlatform(beforeStatus);
  const plan = await installer.plan(skill, scope, force, context);
  const hasBlockedTarget = plan.targets.some((target) => target.action.kind === "refuse-newer");

  if (!hasBlockedTarget) {
    await installer.apply(skill, plan, context);
  }

  const installResults = plan.targets.flatMap((target) => {
    const previous = beforeByPlatform.get(target.platform);
    const action =
      hasBlockedTarget && writesDuringApply(target.action)
        ? "skipped"
        : mapInstallAction(target.action, previous?.installed === true);
    const warning =
      hasBlockedTarget && writesDuringApply(target.action)
        ? blockedPlanWarning()
        : actionWarning(target.action);
    return target.files.map((file) => ({
      path: file.dest_path,
      action,
      warning,
    }));
  });

  const cleanupResults = await cleanupDeprecatedClaudeSkill(scope, context);
  return [...installResults, ...cleanupResults];
}

async function buildRemoveResults(
  scope: Scope,
  context: InstallerContext,
  installer: SkillInstaller,
): Promise<FileResult[]> {
  const report = await installer.remove(scope, context);
  return report.removed_dirs.map((path) => ({ path, action: "removed" as const }));
}

function buildOutput(results: FileResult[], remove: boolean, success: boolean): InitResult {
  const summary = summarize(results);
  return {
    success,
    message: remove
      ? `Skill files removed: ${summary}`
      : success
        ? `Skill files installed: ${summary}`
        : `Skill files skipped: ${summary}`,
    version: VERSION,
    files: results,
  };
}

function humanScopeLabel(scope: Scope): string {
  return scope === "global" ? "global (~/.claude)" : "local";
}

function printHumanOutput(
  output: InitResult,
  scope: Scope,
  remove: boolean,
  log: (...args: unknown[]) => void,
): void {
  const title = remove ? "skill removal" : "skill files";
  log(`\nHopper v${VERSION} — ${title} (${humanScopeLabel(scope)})\n`);
  for (const result of output.files) {
    log(`  ${result.action}: ${result.path}`);
    if (result.warning) {
      log(`    ${result.warning}`);
    }
  }
  log(`\n${output.message.replace(/^Skill files (installed|removed|skipped): /, "")}`);
}

export async function initCommand(options: InitCommandOptions, deps: InitDeps = {}): Promise<void> {
  const scope = options.scope ?? "global";
  const force = options.force ?? false;
  const remove = options.remove ?? false;
  const context = deps.context ?? createContext();
  const installer = deps.installer ?? createInstaller();
  const log = deps.log ?? console.log;

  const results = remove
    ? await buildRemoveResults(scope, context, installer)
    : await buildInstallResults(scope, force, context, installer);
  const skipped = results.some((result) => result.action === "skipped");
  const output = buildOutput(results, remove, !skipped);

  if (options.jsonOutput) {
    log(JSON.stringify(output));
    return;
  }

  printHumanOutput(output, scope, remove, log);
}
