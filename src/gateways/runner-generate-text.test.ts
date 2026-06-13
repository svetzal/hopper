import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Profile } from "../profile.ts";
import { buildGenerateText } from "./runner-generate-text.ts";

const fakeProfile: Profile = {
  name: "test",
  runner: "claude",
  models: {
    deep: { model: "opus" },
    balanced: { model: "sonnet" },
    fast: { model: "haiku" },
  },
};

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

describe("buildGenerateText", () => {
  test("passes prompt, model, profile, and appendSystemPrompt to runSession", async () => {
    let capturedPrompt = "";
    let capturedModel = "";
    let capturedProfile: Profile | undefined;
    let capturedAppendSystemPrompt: string | undefined;

    const fakeRunSession = async (
      prompt: string,
      _cwd: string,
      _auditFile: string,
      options: { model: string; profile: Profile; appendSystemPrompt?: string },
    ) => {
      capturedPrompt = prompt;
      capturedModel = options.model;
      capturedProfile = options.profile;
      capturedAppendSystemPrompt = options.appendSystemPrompt;
      return { exitCode: 0, result: "output" };
    };

    const generateText = buildGenerateText(fakeRunSession, "test-prefix");
    await generateText("my prompt", "balanced", {
      profile: fakeProfile,
      appendSystemPrompt: "extra instruction",
    });

    expect(capturedPrompt).toBe("my prompt");
    expect(capturedModel).toBe("balanced");
    expect(capturedProfile).toBe(fakeProfile);
    expect(capturedAppendSystemPrompt).toBe("extra instruction");
  });

  test("defaults cwd to process.cwd() when options.cwd is omitted", async () => {
    let capturedCwd = "";

    const fakeRunSession = async (
      _prompt: string,
      cwd: string,
      _auditFile: string,
      _options: { model: string; profile: Profile },
    ) => {
      capturedCwd = cwd;
      return { exitCode: 0, result: "output" };
    };

    const generateText = buildGenerateText(fakeRunSession, "test-prefix");
    await generateText("prompt", "fast", { profile: fakeProfile });

    expect(capturedCwd).toBe(process.cwd());
  });

  test("passes explicit cwd when provided", async () => {
    let capturedCwd = "";

    const fakeRunSession = async (
      _prompt: string,
      cwd: string,
      _auditFile: string,
      _options: { model: string; profile: Profile },
    ) => {
      capturedCwd = cwd;
      return { exitCode: 0, result: "output" };
    };

    const generateText = buildGenerateText(fakeRunSession, "test-prefix");
    await generateText("prompt", "fast", { profile: fakeProfile, cwd: "/tmp/workdir" });

    expect(capturedCwd).toBe("/tmp/workdir");
  });

  test("returns trimmed result text and passes exitCode through unchanged", async () => {
    const fakeRunSession = async () => ({
      exitCode: 42,
      result: "  \n  hello world  \n  ",
    });

    const generateText = buildGenerateText(fakeRunSession, "test-prefix");
    const { exitCode, text } = await generateText("prompt", "fast", { profile: fakeProfile });

    expect(text).toBe("hello world");
    expect(exitCode).toBe(42);
  });

  test("audit path begins with the tmpPrefix and lives under OS temp dir", async () => {
    let capturedAuditFile = "";

    const fakeRunSession = async (
      _prompt: string,
      _cwd: string,
      auditFile: string,
      _options: { model: string; profile: Profile },
    ) => {
      capturedAuditFile = auditFile;
      return { exitCode: 0, result: "" };
    };

    const generateText = buildGenerateText(fakeRunSession, "my-runner-gen");
    await generateText("prompt", "fast", { profile: fakeProfile });

    expect(capturedAuditFile.startsWith(tmpdir())).toBe(true);
    expect(capturedAuditFile).toContain("my-runner-gen");
  });

  test("temp audit file is cleaned up after successful runSession", async () => {
    let capturedAuditFile = "";

    const fakeRunSession = async (
      _prompt: string,
      _cwd: string,
      auditFile: string,
      _options: { model: string; profile: Profile },
    ) => {
      capturedAuditFile = auditFile;
      await Bun.write(auditFile, "fake audit content");
      return { exitCode: 0, result: "result" };
    };

    const generateText = buildGenerateText(fakeRunSession, "test-cleanup");
    await generateText("prompt", "fast", { profile: fakeProfile });

    expect(await fileExists(capturedAuditFile)).toBe(false);
  });

  test("temp audit file is cleaned up even when runSession throws", async () => {
    let capturedAuditFile = "";

    const fakeRunSession = async (
      _prompt: string,
      _cwd: string,
      auditFile: string,
      _options: { model: string; profile: Profile },
    ) => {
      capturedAuditFile = auditFile;
      await Bun.write(auditFile, "fake audit content");
      throw new Error("runSession failed");
    };

    const generateText = buildGenerateText(fakeRunSession, "test-cleanup-throw");
    await expect(generateText("prompt", "fast", { profile: fakeProfile })).rejects.toThrow(
      "runSession failed",
    );

    expect(await fileExists(capturedAuditFile)).toBe(false);
  });
});
