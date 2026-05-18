import { describe, expect, test } from "bun:test";
import { extractCraftspersonBody } from "./craftsperson-body.ts";

describe("extractCraftspersonBody", () => {
  test("returns the body following YAML frontmatter, trimmed", () => {
    const md = `---
name: rust-craftsperson
description: A Rust expert
---

You are a Rust expert. Be concise and idiomatic.
`;
    expect(extractCraftspersonBody(md)).toBe("You are a Rust expert. Be concise and idiomatic.");
  });

  test("handles multi-line descriptions in frontmatter", () => {
    const md = `---
name: ruby-craftsperson
description: |
  Rails-aware
  craftsperson
---
You write idiomatic Ruby.
Use \`frozen_string_literal: true\` everywhere.
`;
    expect(extractCraftspersonBody(md)).toBe(
      "You write idiomatic Ruby.\nUse `frozen_string_literal: true` everywhere.",
    );
  });

  test("returns full content (trimmed) when frontmatter delimiters are missing", () => {
    const md = "  You are a helpful assistant.  \n";
    expect(extractCraftspersonBody(md)).toBe("You are a helpful assistant.");
  });

  test("returns full content when only an opening delimiter is present", () => {
    const md = "---\nname: broken\n";
    expect(extractCraftspersonBody(md)).toBe(md.trim());
  });

  test("returns empty string when the body is empty", () => {
    const md = `---
name: empty
description: empty
---

`;
    expect(extractCraftspersonBody(md)).toBe("");
  });
});
