import {
  buildNewItem,
  formatValidationError,
  resolveDependencies,
  resolveScheduling,
  validateDirBranch,
  validateRetries,
  validateTaskType,
  validateTimesSpec,
} from "../add-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { Status, TaskType } from "../constants.ts";
import { shortId } from "../format.ts";
import type { ProfilesGateway } from "../gateways/profiles-gateway.ts";
import { findPreset } from "../presets.ts";
import type { Priority } from "../priority.ts";
import { parsePriority, priorityBadge } from "../priority.ts";
import type { Profile } from "../profile.ts";
import { isValidProfileName } from "../profile.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { addItem, loadItems } from "../store.ts";
import { mergeTags, normalizeTags, tagBadge } from "../tags.ts";
import type { TitleGenerator } from "../titler.ts";

/**
 * Optional callback that resolves a craftsperson agent for an engineering
 * item. Called only when `--type engineering` is set, `--agent` is not, and
 * the item has a working directory to probe for project markers.
 *
 * Returns `null` when no suitable agent exists — the item is then enqueued
 * with no agent, and the worker runs the execute phase with Claude's default.
 */
export type AgentResolver = (input: {
  title: string;
  description: string;
  workingDir: string;
  profile: Profile;
}) => Promise<string | null>;

export function addCommand(
  parsed: ParsedArgs,
  titler: TitleGenerator,
  profilesGateway: ProfilesGateway,
  readStdin: () => Promise<string> = () => new Response(Bun.stdin.stream()).text(),
  resolveAgent?: AgentResolver,
): Promise<CommandResult<Item>> {
  return catchCommandError(async () => {
    // 1. Resolve preset (I/O)
    const presetName = stringFlag(parsed, "preset");
    let preset: Awaited<ReturnType<typeof findPreset>>;
    if (presetName) {
      preset = await findPreset(presetName);
      if (!preset) {
        return { status: "error", message: `No preset found with name: ${presetName}` };
      }
    }

    // 2. Get description from args or stdin (I/O)
    let description = parsed.positional[0] ?? "";

    if (!description && !process.stdin.isTTY) {
      description = (await readStdin()).trim();
    }

    if (!description && preset) {
      description = preset.description;
    }

    // 3. Validate description exists
    if (!description) {
      return { status: "error", message: formatValidationError({ code: "MISSING_DESCRIPTION" }) };
    }

    // 4. Generate title (I/O)
    const title = await titler.generateTitle(description);

    // 5. Resolve dir/branch/command from args + preset
    const dir = stringFlag(parsed, "dir") ?? preset?.workingDir;
    const branch = stringFlag(parsed, "branch") ?? preset?.branch;
    const command = stringFlag(parsed, "command") ?? preset?.command;

    // 5a. Resolve and validate task type + agent
    const type = unwrap(
      validateTaskType(stringFlag(parsed, "type") ?? preset?.type),
      formatValidationError,
    );
    let agent = stringFlag(parsed, "agent") ?? preset?.agent;

    // 5b. Resolve profile — flag → preset → defaultProfile from config.json.
    // Always bake the resolved name into the item so behaviour is deterministic
    // across config edits and retries. Bootstraps profiles on first use when
    // either ~/.hopper/config.json or ~/.hopper/profiles/ is missing.
    await profilesGateway.bootstrap();
    const profileFlag = stringFlag(parsed, "profile");
    const hopperConfig = await profilesGateway.loadConfig();
    const profileName = profileFlag ?? hopperConfig.defaultProfile;

    if (!isValidProfileName(profileName)) {
      return {
        status: "error",
        message: `Invalid profile name '${profileName}' — must match [a-z0-9_-]+`,
      };
    }

    const profileResult = await profilesGateway.loadProfile(profileName);
    if (!profileResult.ok) {
      const available = await profilesGateway.listProfileNames();
      const hint =
        available.length > 0
          ? `Available profiles: ${available.join(", ")}`
          : "No profiles installed.";
      return {
        status: "error",
        message: `Profile '${profileName}': ${profileResult.error}\n${hint}`,
      };
    }
    const profile = profileResult.profile;

    // Parse --retries. Preset fallback is an already-validated integer, so we
    // only need to validate the CLI string form.
    const retriesRaw = stringFlag(parsed, "retries");
    const retries_ = unwrap(validateRetries(retriesRaw), formatValidationError);
    const retries = retries_ ?? preset?.retries;

    // Auto-resolve a craftsperson for engineering items when the caller didn't
    // pin one explicitly. Failures are swallowed — a missing agent is always
    // preferable to a wrong one, and the worker runs fine without.
    if (!agent && type === TaskType.ENGINEERING && dir && resolveAgent) {
      try {
        const resolved = await resolveAgent({ title, description, workingDir: dir, profile });
        if (resolved) agent = resolved;
      } catch {
        // failure swallowed — missing agent is preferable to a wrong one
      }
    }

    // 6. Validate dir/branch combination (accounting for task type)
    unwrap(validateDirBranch(dir, branch, command, type), formatValidationError);

    // 7. Parse priority
    let priority: Priority | undefined;
    const priorityFlag = stringFlag(parsed, "priority");
    if (priorityFlag) {
      priority = unwrap(parsePriority(priorityFlag));
    }

    // 8. Validate --times spec
    const everySpec = stringFlag(parsed, "every");
    const timesSpec = stringFlag(parsed, "times");
    const timesResult = unwrap(validateTimesSpec(timesSpec, everySpec), formatValidationError);

    // 9. Resolve scheduling
    const afterSpec = stringFlag(parsed, "after");
    const untilSpec = stringFlag(parsed, "until");
    const scheduling = unwrap(
      resolveScheduling(everySpec, afterSpec, untilSpec, timesResult, new Date()),
      formatValidationError,
    );

    // 10. Normalize tags
    const rawTags = parsed.arrayFlags.tag ?? [];
    let tags: string[] | undefined;
    const warnings: string[] = [];
    if (rawTags.length > 0 || preset?.tags?.length) {
      const tagResult = unwrap(normalizeTags(rawTags));
      const presetTags = preset?.tags ?? [];
      tags = mergeTags(presetTags, tagResult);
    }

    // 11. Resolve dependencies (I/O)
    const afterItemIds = parsed.arrayFlags["after-item"] ?? [];
    let dependsOn: string[] | undefined;
    let itemStatus = scheduling.status;

    if (afterItemIds.length > 0) {
      const allItems = await loadItems();
      const depResult = unwrap(resolveDependencies(afterItemIds, allItems), formatValidationError);
      for (const warning of depResult.warnings) {
        warnings.push(warning);
      }
      dependsOn = depResult.resolvedIds;
      itemStatus = Status.BLOCKED;
    }

    // 12. Build item
    const item = buildNewItem({
      id: crypto.randomUUID(),
      title,
      description,
      status: itemStatus,
      createdAt: new Date().toISOString(),
      priority,
      scheduledAt: scheduling.scheduledAt,
      dir,
      branch,
      command,
      recurrence: scheduling.recurrence,
      dependsOn,
      tags,
      type,
      agent,
      profile: profile.name,
      retries,
    });

    // 13. Save item (I/O)
    await addItem(item);

    // 14. Build human output
    const presetSuffix = preset ? ` (from preset: ${preset.name})` : "";
    const pBadge = priorityBadge(priority);
    const tBadge = tagBadge(tags);
    let humanOutput: string;
    if (dependsOn) {
      const depBadge = dependsOn.map((id) => shortId(id)).join(", ");
      humanOutput = `Added: ${title}${pBadge}${tBadge} (blocked on: ${depBadge})${presetSuffix}`;
    } else if (scheduling.recurrence) {
      humanOutput = `Added: ${title}${pBadge}${tBadge} (recurring every ${scheduling.recurrence.interval}, next run: ${scheduling.scheduledAt ? new Date(scheduling.scheduledAt).toLocaleString() : "unknown"})${presetSuffix}`;
    } else if (scheduling.scheduledAt) {
      humanOutput = `Added: ${title}${pBadge}${tBadge} (scheduled for ${new Date(scheduling.scheduledAt).toLocaleString()})${presetSuffix}`;
    } else {
      humanOutput = `Added: ${title}${pBadge}${tBadge}${presetSuffix}`;
    }

    return {
      status: "success",
      data: item,
      humanOutput,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
