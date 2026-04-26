import {
  decodeEvents,
  formatAuditSummary,
  formatDecodedEvents,
  type PhaseInput,
  parsePhaseFromFilename,
  summarizeEvents,
} from "../audit-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { booleanFlag, requirePositional, stringFlag } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import type { AuditGateway } from "../gateways/audit-gateway.ts";
import { findItem } from "../store.ts";
import { withStoreError } from "./with-store-error.ts";

const USAGE = "Usage: hopper audit <id> [--tail <n>] [--plan|--result] [--phase <name>]";

export async function auditCommand(
  parsed: ParsedArgs,
  gateway: AuditGateway,
): Promise<CommandResult> {
  const idArg = requirePositional(parsed, 0, USAGE);
  if (!idArg.ok) return idArg.error;

  const tailStr = stringFlag(parsed, "tail");
  const planFlag = booleanFlag(parsed, "plan");
  const resultFlag = booleanFlag(parsed, "result");
  const phaseFilter = stringFlag(parsed, "phase");

  // ── Validate flag combinations before any I/O ─────────────────────────────

  if (planFlag && resultFlag) {
    return {
      status: "error",
      message: "Cannot use --plan and --result together — choose one.",
    };
  }

  if (phaseFilter && (planFlag || resultFlag)) {
    return {
      status: "error",
      message: "--phase cannot be combined with --plan or --result.",
    };
  }

  if (tailStr && (planFlag || resultFlag)) {
    return {
      status: "error",
      message: "--tail cannot be combined with --plan or --result.",
    };
  }

  let tailN: number | undefined;
  if (tailStr !== undefined) {
    tailN = Number.parseInt(tailStr, 10);
    if (!Number.isInteger(tailN) || tailN < 1) {
      return {
        status: "error",
        message: `--tail requires a positive integer (got "${tailStr}"). ${USAGE}`,
      };
    }
  }

  return withStoreError(async () => {
    const item = await findItem(idArg.value);
    const { plan: planPath, result: resultPath } = gateway.paths(item.id);

    // ── --plan ────────────────────────────────────────────────────────────────

    if (planFlag) {
      const content = await gateway.readMarkdown(planPath);
      if (content === null) {
        return {
          status: "error",
          message: `No plan found for ${item.id.slice(0, 8)} (not an engineering item, or plan phase has not run yet).`,
        };
      }
      return {
        status: "success",
        data: { plan: content },
        humanOutput: content,
      };
    }

    // ── --result ──────────────────────────────────────────────────────────────

    if (resultFlag) {
      const content = await gateway.readMarkdown(resultPath);
      if (content === null) {
        if (item.status === "in_progress") {
          const placeholder = "(in progress — see audit summary)";
          return {
            status: "success",
            data: { result: null, inProgress: true },
            humanOutput: placeholder,
          };
        }
        return {
          status: "error",
          message: `No result found for ${item.id.slice(0, 8)}.`,
        };
      }
      return {
        status: "success",
        data: { result: content },
        humanOutput: content,
      };
    }

    // ── Gather phase files ────────────────────────────────────────────────────

    const phaseFiles = await gateway.listPhaseFiles(item.id);

    // Apply --phase filter (engineering items only)
    const filteredFiles =
      phaseFilter !== undefined
        ? (() => {
            if (item.type !== "engineering") {
              return null; // signal an error
            }
            return phaseFiles.filter((f) => {
              const phase = parsePhaseFromFilename(item.id, f.name);
              return (
                phase !== null && (phase === phaseFilter || phase.startsWith(`${phaseFilter}-`))
              );
            });
          })()
        : phaseFiles;

    if (filteredFiles === null) {
      return {
        status: "error",
        message: `--phase is only available for engineering items. Item ${item.id.slice(0, 8)} has type "${item.type ?? "task"}".`,
      };
    }

    // Build PhaseInput array
    const phaseInputs: PhaseInput[] = [];
    for (const file of filteredFiles) {
      const result = await gateway.readJsonlLines(file.path);
      if (result) {
        const phase = parsePhaseFromFilename(item.id, file.name) ?? file.name;
        phaseInputs.push({ phase, lines: result.lines, mtimeMs: result.mtimeMs });
      }
    }

    // ── --tail <n> ────────────────────────────────────────────────────────────

    if (tailN !== undefined) {
      const events = decodeEvents(phaseInputs, tailN);
      return {
        status: "success",
        data: events,
        humanOutput: formatDecodedEvents(events),
      };
    }

    // ── Default: summary ──────────────────────────────────────────────────────

    const summary = summarizeEvents(phaseInputs, Date.now());
    return {
      status: "success",
      data: { itemId: item.id, status: item.status, ...summary },
      humanOutput: formatAuditSummary(item, summary),
    };
  });
}
