import { parsePhaseFromFilename } from "../audit-workflow.ts";
import type { ParsedArgs } from "../cli.ts";
import { unwrapPositional } from "../command-flags.ts";
import type { CommandResult } from "../command-result.ts";
import { aggregatePhaseCosts, type CostBreakdown, type PhaseLines } from "../extract-cost.ts";
import { formatItemDetail } from "../format.ts";
import type { AuditGateway } from "../gateways/audit-gateway.ts";
import { catchCommandError, unwrap } from "../result.ts";
import type { Item } from "../store.ts";
import { findItem } from "../store.ts";

export interface ShowResultData {
  item: Item;
  cost: CostBreakdown;
}

/**
 * Load every phase audit file for an item and aggregate cost telemetry.
 * Phases are ordered by mtime so the output mirrors the runner's actual
 * execution sequence (plan, execute, execute-2, validate, validate-2, …).
 */
async function loadCostBreakdown(gateway: AuditGateway, itemId: string): Promise<CostBreakdown> {
  const files = await gateway.listPhaseFiles(itemId);
  // Sort by mtime ascending — chronological order matches what a reader expects.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const inputs: PhaseLines[] = [];
  for (const file of files) {
    const phase = parsePhaseFromFilename(itemId, file.name);
    if (!phase) continue;
    const read = await gateway.readJsonlLines(file.path);
    if (!read) continue;
    inputs.push({ phase, lines: read.lines });
  }
  return aggregatePhaseCosts(inputs);
}

export function showCommand(
  parsed: ParsedArgs,
  gateway: AuditGateway,
): Promise<CommandResult<ShowResultData>> {
  return catchCommandError(async () => {
    const id = unwrapPositional(parsed, 0, "Usage: hopper show <id>");
    const item = unwrap(await findItem(id));
    const cost = await loadCostBreakdown(gateway, item.id);
    return {
      status: "success",
      data: { item, cost },
      humanOutput: formatItemDetail(item, cost),
    };
  });
}
