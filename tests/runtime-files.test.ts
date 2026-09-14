import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureFileContent, localFileUrl } from "../src/runtime-files";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-api-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureFileContent", () => {
  it("creates, reuses, and updates one stable file", () => {
    const filePath = path.join(createTempDir(), "nested", "bridge.js");

    expect(ensureFileContent(filePath, "first")).toBe("created");
    expect(ensureFileContent(filePath, "first")).toBe("unchanged");
    expect(ensureFileContent(filePath, "second")).toBe("updated");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("second");
  });
});

describe("localFileUrl", () => {
  it("creates a valid file URL with encoded spaces", () => {
    const filePath = path.join(os.tmpdir(), "Vault API", "note #1.md");
    const url = localFileUrl(filePath);

    expect(url).toMatch(/^file:\/\/\//);
    expect(url).toContain("Vault%20API");
    expect(url).toContain("note%20%231.md");
  });
});
