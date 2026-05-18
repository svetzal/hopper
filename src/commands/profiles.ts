import type { ParsedArgs } from "../cli.ts";
import type { CommandResult } from "../command-result.ts";
import type { ProfilesGateway } from "../gateways/profiles-gateway.ts";
import { catchCommandError } from "../result.ts";

export interface ProfileListEntry {
  name: string;
  runner: "claude" | "opencode";
  deep: string;
  balanced: string;
  fast: string;
}

export interface ProfileListData {
  defaultProfile: string;
  profiles: ProfileListEntry[];
  /** Profile files that failed to parse — listed so the user can fix them. */
  errors: Array<{ name: string; error: string }>;
}

/**
 * `hopper profiles` — list every profile on disk plus the default.
 *
 * `hopper profiles show <name>` — print a specific profile's file content.
 */
export function profilesCommand(
  parsed: ParsedArgs,
  gateway: ProfilesGateway,
): Promise<CommandResult<ProfileListData | string>> {
  return catchCommandError<ProfileListData | string>(async () => {
    // Bootstrap so a fresh ~/.hopper/ becomes inhabited before we try to list.
    await gateway.bootstrap();

    const sub = parsed.positional[0];
    if (sub === "show") {
      const name = parsed.positional[1];
      if (!name) {
        return { status: "error", message: "Usage: hopper profiles show <name>" };
      }
      const result = await gateway.loadProfile(name);
      if (!result.ok) {
        return { status: "error", message: result.error };
      }
      const path = gateway.profilePath(name);
      const body = JSON.stringify(
        { runner: result.profile.runner, models: result.profile.models },
        null,
        2,
      );
      return {
        status: "success",
        data: body,
        humanOutput: `# ${path}\n${body}`,
      };
    }

    if (sub !== undefined) {
      return {
        status: "error",
        message: `Unknown subcommand 'profiles ${sub}'. Try 'hopper profiles' or 'hopper profiles show <name>'.`,
      };
    }

    const { profiles, errors } = await gateway.loadAllProfiles();
    const config = await gateway.loadConfig();

    const entries: ProfileListEntry[] = profiles.map((p) => ({
      name: p.name,
      runner: p.runner,
      deep: p.models.deep ?? "",
      balanced: p.models.balanced ?? "",
      fast: p.models.fast ?? "",
    }));

    const lines: string[] = [];
    lines.push(`Default profile: ${config.defaultProfile}`);
    lines.push("");
    if (entries.length === 0) {
      lines.push("(no profiles found — drop a JSON file into ~/.hopper/profiles/)");
    } else {
      // Two-line layout per profile: header + indented tier mapping. Keeps
      // wide model IDs (e.g. ollama/qwen3.6:27b-coding-bf16) readable.
      for (const entry of entries) {
        const mark = entry.name === config.defaultProfile ? "* " : "  ";
        lines.push(`${mark}${entry.name}  (${entry.runner})`);
        lines.push(`      deep:     ${entry.deep}`);
        lines.push(`      balanced: ${entry.balanced}`);
        lines.push(`      fast:     ${entry.fast}`);
      }
    }
    if (errors.length > 0) {
      lines.push("");
      lines.push("Errors:");
      for (const e of errors) {
        lines.push(`  ${e.name}: ${e.error}`);
      }
    }

    return {
      status: "success",
      data: { defaultProfile: config.defaultProfile, profiles: entries, errors },
      humanOutput: lines.join("\n"),
    };
  });
}
