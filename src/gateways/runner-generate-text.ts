import { unlink } from "node:fs/promises";
import type { Profile } from "../profile.ts";
import { generateTempFilename } from "./audit-stream.ts";

type RunSession = (
  prompt: string,
  cwd: string,
  auditFile: string,
  options: { model: string; profile: Profile; appendSystemPrompt?: string },
) => Promise<{ exitCode: number; result: string }>;

export function buildGenerateText(runSession: RunSession, tmpPrefix: string) {
  return async function generateText(
    prompt: string,
    model: string,
    options: { profile: Profile; cwd?: string; appendSystemPrompt?: string },
  ): Promise<{ exitCode: number; text: string }> {
    const tmpAudit = generateTempFilename(tmpPrefix, "jsonl");
    try {
      const { exitCode, result } = await runSession(
        prompt,
        options.cwd ?? process.cwd(),
        tmpAudit,
        {
          model,
          profile: options.profile,
          appendSystemPrompt: options.appendSystemPrompt,
        },
      );
      return { exitCode, text: result.trim() };
    } finally {
      await unlink(tmpAudit).catch(() => undefined);
    }
  };
}
