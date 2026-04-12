import { describe, expect, test } from "bun:test";
import {
  type AgentCandidate,
  buildSelectionPrompt,
  detectProjectMarkers,
  mergeAgentCandidates,
  PROJECT_MARKERS,
  parseAgentFrontmatter,
  parseSelectionResponse,
} from "./craftsperson-resolver.ts";

describe("parseAgentFrontmatter", () => {
  test("parses simple name and description on single lines", () => {
    const md = `---
name: rust-craftsperson
description: Idiomatic Rust with clippy and cargo.
---

Body text.
`;
    expect(parseAgentFrontmatter(md)).toEqual({
      name: "rust-craftsperson",
      description: "Idiomatic Rust with clippy and cargo.",
    });
  });

  test("strips matching double and single quotes from values", () => {
    const md = `---
name: "go-craftsperson"
description: 'Idiomatic Go with gofmt and golangci-lint.'
---
`;
    expect(parseAgentFrontmatter(md)).toEqual({
      name: "go-craftsperson",
      description: "Idiomatic Go with gofmt and golangci-lint.",
    });
  });

  test("handles a literal block scalar description", () => {
    const md = `---
name: python-craftsperson
description: |
  Idiomatic Python with pytest and ruff.
  Works on standard pip projects.
---
`;
    const result = parseAgentFrontmatter(md);
    expect(result?.name).toBe("python-craftsperson");
    expect(result?.description).toContain("Idiomatic Python");
    expect(result?.description).toContain("standard pip projects");
  });

  test("handles a folded block scalar description", () => {
    const md = `---
name: kotlin-craftsperson
description: >
  Server-side Kotlin with
  Ktor and coroutines.
---
`;
    const result = parseAgentFrontmatter(md);
    expect(result?.description).toBe("Server-side Kotlin with Ktor and coroutines.");
  });

  test("returns null when name is missing", () => {
    const md = `---
description: just a description
---
`;
    expect(parseAgentFrontmatter(md)).toBeNull();
  });

  test("returns null when description is missing", () => {
    const md = `---
name: mystery
---
`;
    expect(parseAgentFrontmatter(md)).toBeNull();
  });

  test("returns null when there is no frontmatter block", () => {
    expect(parseAgentFrontmatter("# Just a markdown doc")).toBeNull();
  });
});

describe("mergeAgentCandidates", () => {
  test("local entries shadow global entries with the same name", () => {
    const global: AgentCandidate[] = [
      { name: "rust-craftsperson", description: "old", source: "global" },
      { name: "go-craftsperson", description: "go", source: "global" },
    ];
    const local: AgentCandidate[] = [
      { name: "rust-craftsperson", description: "customised", source: "local" },
    ];

    const merged = mergeAgentCandidates(global, local);

    const rust = merged.find((c) => c.name === "rust-craftsperson");
    expect(rust?.description).toBe("customised");
    expect(rust?.source).toBe("local");
    // go is still present
    expect(merged.find((c) => c.name === "go-craftsperson")?.source).toBe("global");
  });

  test("preserves all unique names", () => {
    const merged = mergeAgentCandidates(
      [{ name: "a", description: "a", source: "global" }],
      [{ name: "b", description: "b", source: "local" }],
    );
    expect(merged.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });
});

describe("detectProjectMarkers", () => {
  test("returns the subset of known markers present in the map", () => {
    const markers = detectProjectMarkers({
      "package.json": true,
      "tsconfig.json": true,
      "Cargo.toml": false,
      "bun.lockb": true,
      "random.txt": true, // not a known marker
    });
    expect(markers).toEqual(["package.json", "bun.lockb", "tsconfig.json"]);
  });

  test("returns an empty list when nothing is present", () => {
    expect(detectProjectMarkers({})).toEqual([]);
  });

  test("PROJECT_MARKERS contains the expected anchors for polyglot detection", () => {
    for (const expected of [
      "package.json",
      "tsconfig.json",
      "Cargo.toml",
      "go.mod",
      "mix.exs",
      "pyproject.toml",
      "uv.lock",
      "Gemfile",
      "Package.swift",
      "deps.edn",
    ]) {
      expect(PROJECT_MARKERS).toContain(expected);
    }
  });
});

describe("buildSelectionPrompt", () => {
  const candidates: AgentCandidate[] = [
    { name: "rust-craftsperson", description: "Idiomatic Rust.", source: "global" },
    { name: "typescript-craftsperson", description: "Modern TypeScript.", source: "global" },
  ];

  test("instructs Haiku to respond with JSON only", () => {
    const prompt = buildSelectionPrompt("t", "d", [], candidates);
    expect(prompt).toContain("JSON ONLY");
    expect(prompt).toContain('"agent"');
  });

  test("inlines title, description, and markers", () => {
    const prompt = buildSelectionPrompt(
      "Refactor parser",
      "Move to nom-based approach.",
      ["Cargo.toml"],
      candidates,
    );
    expect(prompt).toContain("Refactor parser");
    expect(prompt).toContain("Move to nom-based approach.");
    expect(prompt).toContain("Cargo.toml");
  });

  test("shows (none detected) when no markers present", () => {
    const prompt = buildSelectionPrompt("t", "d", [], candidates);
    expect(prompt).toContain("(none detected)");
  });

  test("lists each candidate on its own line with name and description", () => {
    const prompt = buildSelectionPrompt("t", "d", [], candidates);
    expect(prompt).toContain("- rust-craftsperson: Idiomatic Rust.");
    expect(prompt).toContain("- typescript-craftsperson: Modern TypeScript.");
  });

  test("truncates candidate descriptions over 200 chars", () => {
    const longDesc = "x".repeat(500);
    const prompt = buildSelectionPrompt(
      "t",
      "d",
      [],
      [{ name: "verbose", description: longDesc, source: "global" }],
    );
    expect(prompt).toContain("…");
    expect(prompt).not.toContain(longDesc);
  });
});

describe("parseSelectionResponse", () => {
  const candidates: AgentCandidate[] = [
    { name: "rust-craftsperson", description: "a", source: "global" },
    { name: "go-craftsperson", description: "b", source: "global" },
  ];

  test("returns the selected name for valid JSON matching a known candidate", () => {
    expect(parseSelectionResponse('{"agent": "rust-craftsperson"}', candidates)).toBe(
      "rust-craftsperson",
    );
  });

  test("returns null for agent: null", () => {
    expect(parseSelectionResponse('{"agent": null}', candidates)).toBeNull();
  });

  test("returns null when Haiku hallucinates a name not in the candidate set", () => {
    expect(parseSelectionResponse('{"agent": "invented-craftsperson"}', candidates)).toBeNull();
  });

  test("extracts JSON from a response wrapped in prose", () => {
    const raw = 'Sure! Here is my pick: {"agent": "go-craftsperson"} — let me know.';
    expect(parseSelectionResponse(raw, candidates)).toBe("go-craftsperson");
  });

  test("returns null for invalid JSON", () => {
    expect(parseSelectionResponse('{"agent": rust}', candidates)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseSelectionResponse("", candidates)).toBeNull();
    expect(parseSelectionResponse("   ", candidates)).toBeNull();
  });

  test("returns null when agent is not a string or null", () => {
    expect(parseSelectionResponse('{"agent": 42}', candidates)).toBeNull();
    expect(parseSelectionResponse('{"agent": ["rust-craftsperson"]}', candidates)).toBeNull();
  });

  test("returns null when JSON object has no agent key", () => {
    expect(parseSelectionResponse('{"name": "rust-craftsperson"}', candidates)).toBeNull();
  });
});
