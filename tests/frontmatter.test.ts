import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import * as nodePath from "node:path";
import { toolReadFrontmatter, toolUpdateFrontmatter } from "../src/vault-tools";

// "obsidian" resolves to tests/mocks/obsidian.ts through vitest.config.ts.

function fakeApp(content: string, withProcessFrontMatter = true) {
  const file = new (TFile as unknown as new (p: string) => TFile)("note.md");
  const state = { content, processed: null as Record<string, unknown> | null };
  const app = {
    vault: {
      // Native absolute path: "/vault" resolves to "D:\vault" on Windows.
      adapter: { basePath: nodePath.resolve("/vault") },
      getAbstractFileByPath: (p: string) => (p === "note.md" ? file : null),
      read: async () => state.content,
    },
    fileManager: withProcessFrontMatter
      ? {
          processFrontMatter: async (_f: unknown, fn: (fm: Record<string, unknown>) => void) => {
            const fm: Record<string, unknown> = { "created-at": "2026-01-01", tags: ["a", "b"] };
            fn(fm);
            state.processed = fm;
          },
        }
      : {},
  };
  return { app: app as never, state };
}

describe("toolReadFrontmatter", () => {
  it("keeps lists and hyphenated keys", async () => {
    const { app } = fakeApp("---\ncreated-at: 2026-01-01\ntags:\n  - a\n  - b\n---\nBody\n");
    const r = await toolReadFrontmatter(app, "note.md");
    expect(r.hasFrontmatter).toBe(true);
    expect(r.frontmatter).toEqual({ "created-at": "2026-01-01", tags: ["a", "b"] });
  });

  it("accepts CRLF line endings", async () => {
    const { app } = fakeApp("---\r\ntitle: Hi\r\n---\r\nBody");
    const r = await toolReadFrontmatter(app, "note.md");
    expect(r.frontmatter).toEqual({ title: "Hi" });
  });

  it("accepts an empty block", async () => {
    const { app } = fakeApp("---\n---\nBody");
    const r = await toolReadFrontmatter(app, "note.md");
    expect(r).toMatchObject({ hasFrontmatter: true, frontmatter: {}, raw: "" });
  });

  it("reports notes without frontmatter", async () => {
    const { app } = fakeApp("Just text");
    const r = await toolReadFrontmatter(app, "note.md");
    expect(r).toMatchObject({ hasFrontmatter: false, raw: null });
  });

  it("reports invalid YAML instead of returning partial data", async () => {
    const { app } = fakeApp("---\nbad: [\n---\n");
    await expect(toolReadFrontmatter(app, "note.md")).rejects.toThrow(/Invalid YAML frontmatter/);
  });
});

describe("toolUpdateFrontmatter", () => {
  it("changes only the requested keys", async () => {
    const { app, state } = fakeApp("---\ncreated-at: 2026-01-01\n---\n");
    const r = await toolUpdateFrontmatter(app, "note.md", { status: "done", tags: null });
    expect(r.action).toBe("frontmatter_updated");
    expect(state.processed).toEqual({ "created-at": "2026-01-01", status: "done" });
  });

  it("does not create frontmatter when every update is a deletion", async () => {
    const { app, state } = fakeApp("No frontmatter here");
    const r = await toolUpdateFrontmatter(app, "note.md", { status: null });
    expect(r.action).toBe("unchanged");
    expect(state.processed).toBeNull();
  });

  it("refuses to write on Obsidian versions without processFrontMatter", async () => {
    const { app } = fakeApp("---\na: b\n---\n", false);
    await expect(toolUpdateFrontmatter(app, "note.md", { a: "c" })).rejects.toThrow(/1\.4\.4/);
  });
});
