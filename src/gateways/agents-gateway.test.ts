import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAgentsGateway } from "./agents-gateway.ts";

const gateway = createAgentsGateway();

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agents-gateway-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

function agentFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
}

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
  test("returns candidates from .md files with valid frontmatter", async () => {
    const globalDir = join(tempDir, "global");
    await mkdir(globalDir);
    await writeFile(join(globalDir, "agent-one.md"), agentFile("agent-one", "Does one thing"));

    const result = await gateway.discoverAgents(globalDir, join(tempDir, "no-local"));

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("agent-one");
    expect(result[0]?.description).toBe("Does one thing");
    expect(result[0]?.source).toBe("global");
  });

  test("local agents have source=local", async () => {
    const localDir = join(tempDir, "local");
    await mkdir(localDir);
    await writeFile(join(localDir, "local-agent.md"), agentFile("local-agent", "Local thing"));

    const result = await gateway.discoverAgents(join(tempDir, "no-global"), localDir);

    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("local");
  });

  test("non-.md files are skipped", async () => {
    const globalDir = join(tempDir, "global");
    await mkdir(globalDir);
    await writeFile(join(globalDir, "agent.txt"), agentFile("txt-agent", "should be skipped"));
    await writeFile(join(globalDir, "agent.json"), `{"name":"json-agent"}`);
    await writeFile(join(globalDir, "valid.md"), agentFile("valid-agent", "Valid"));

    const result = await gateway.discoverAgents(globalDir, join(tempDir, "no-local"));

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("valid-agent");
  });

  test("local shadows global: same name in both dirs returns only local", async () => {
    const globalDir = join(tempDir, "global");
    const localDir = join(tempDir, "local");
    await mkdir(globalDir);
    await mkdir(localDir);
    await writeFile(join(globalDir, "shared.md"), agentFile("shared-agent", "Global version"));
    await writeFile(join(localDir, "shared.md"), agentFile("shared-agent", "Local version"));

    const result = await gateway.discoverAgents(globalDir, localDir);

    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("Local version");
    expect(result[0]?.source).toBe("local");
  });

  test("empty directories return empty array without crashing", async () => {
    const globalDir = join(tempDir, "global");
    const localDir = join(tempDir, "local");
    await mkdir(globalDir);
    await mkdir(localDir);

    const result = await gateway.discoverAgents(globalDir, localDir);

    expect(result).toHaveLength(0);
  });

  test("missing directories return empty array without crashing", async () => {
    const result = await gateway.discoverAgents(
      join(tempDir, "no-global"),
      join(tempDir, "no-local"),
    );

    expect(result).toHaveLength(0);
  });

  test("files with invalid or missing frontmatter are skipped gracefully", async () => {
    const globalDir = join(tempDir, "global");
    await mkdir(globalDir);
    await writeFile(join(globalDir, "no-frontmatter.md"), "# Just a heading\n");
    await writeFile(join(globalDir, "only-name.md"), "---\nname: incomplete\n---\n");
    await writeFile(join(globalDir, "valid.md"), agentFile("valid-agent", "Has both fields"));

    const result = await gateway.discoverAgents(globalDir, join(tempDir, "no-local"));

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("valid-agent");
  });

  test("both global and local agents combined when no name collision", async () => {
    const globalDir = join(tempDir, "global");
    const localDir = join(tempDir, "local");
    await mkdir(globalDir);
    await mkdir(localDir);
    await writeFile(join(globalDir, "global-only.md"), agentFile("global-agent", "Global"));
    await writeFile(join(localDir, "local-only.md"), agentFile("local-agent", "Local"));

    const result = await gateway.discoverAgents(globalDir, localDir);

    expect(result).toHaveLength(2);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(["global-agent", "local-agent"]);
  });
});

// ---------------------------------------------------------------------------
// probeProjectMarkers
// ---------------------------------------------------------------------------

describe("probeProjectMarkers", () => {
  test("returns correct boolean map for present and absent files", async () => {
    const projectDir = join(tempDir, "project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "package.json"), "{}");

    const result = await gateway.probeProjectMarkers(projectDir, ["package.json", "Cargo.toml"]);

    expect(result["package.json"]).toBe(true);
    expect(result["Cargo.toml"]).toBe(false);
  });

  test("empty markers list returns empty object", async () => {
    const projectDir = join(tempDir, "project");
    await mkdir(projectDir);

    const result = await gateway.probeProjectMarkers(projectDir, []);

    expect(result).toEqual({});
  });

  test("all absent markers return false", async () => {
    const projectDir = join(tempDir, "project");
    await mkdir(projectDir);

    const result = await gateway.probeProjectMarkers(projectDir, [
      "package.json",
      "Cargo.toml",
      "go.mod",
    ]);

    expect(result["package.json"]).toBe(false);
    expect(result["Cargo.toml"]).toBe(false);
    expect(result["go.mod"]).toBe(false);
  });
});
