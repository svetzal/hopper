import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let agentsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "craftsperson-loader-test-"));
  agentsDir = join(tempDir, ".claude", "agents");
  await mkdir(agentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

function agentFileContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: test agent\n---\n${body}`;
}

// The loader uses homedir() internally, so we test via a patched version that
// accepts an explicit base path — identical logic, different root.
async function loadCraftspersonBodyAt(
  basePath: string,
  name: string,
): Promise<string | null> {
  const { extractCraftspersonBody } = await import("../craftsperson-body.ts");
  const path = join(basePath, ".claude", "agents", `${name}.md`);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const contents = await file.text().catch(() => null);
  if (contents == null) return null;
  return extractCraftspersonBody(contents);
}

describe("loadCraftspersonBody", () => {
  test("returns the extracted body for an existing agent file", async () => {
    await writeFile(
      join(agentsDir, "my-agent.md"),
      agentFileContent("my-agent", "You are a helpful agent.\n"),
    );

    const result = await loadCraftspersonBodyAt(tempDir, "my-agent");

    expect(result).toBe("You are a helpful agent.");
  });

  test("returns null for a missing file", async () => {
    const result = await loadCraftspersonBodyAt(tempDir, "nonexistent");
    expect(result).toBeNull();
  });

  test("returns empty string for a file with no body after frontmatter", async () => {
    await writeFile(join(agentsDir, "empty-body.md"), "---\nname: empty-body\ndescription: x\n---\n");

    const result = await loadCraftspersonBodyAt(tempDir, "empty-body");

    expect(result).toBe("");
  });

  test("returns full content trimmed when there is no frontmatter delimiter", async () => {
    await writeFile(join(agentsDir, "no-frontmatter.md"), "Just plain text body.");

    const result = await loadCraftspersonBodyAt(tempDir, "no-frontmatter");

    expect(result).toBe("Just plain text body.");
  });
});
