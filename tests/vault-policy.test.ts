import { describe, it, expect } from "vitest";
import {
  BINARY_EXTS,
  IMAGE_EXTS,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_TOTAL_BYTES,
  MAX_TEXT_BYTES,
  SEARCH_DEADLINE_MS,
  classifyExtension,
  formatMegabytes,
  isIgnoredPath,
  shouldScanContent,
} from "../src/vault-policy";

// Fixtures use fictional vault content. The point of these tests is that scan
// and read decisions are made from the file list (path, extension, size)
// before any file is opened.

describe("metadata and sync noise filtering", () => {
  it("ignores Synology and recycle-bin paths", () => {
    expect(isIgnoredPath("My Drive/@eaDir/note.md.md")).toBe(true);
    expect(isIgnoredPath("#recycle/old note.md")).toBe(true);
    expect(isIgnoredPath("vault/.trash/old note.md")).toBe(true);
    expect(isIgnoredPath("notes/.git/config")).toBe(true);
    expect(isIgnoredPath("notes/sub/node_modules/x.md")).toBe(true);
  });

  it("keeps real note paths", () => {
    expect(isIgnoredPath("notes/real note.md")).toBe(false);
    expect(isIgnoredPath("My Drive/Projects/plan.md")).toBe(false);
    expect(isIgnoredPath("assets/photo.png")).toBe(false);
  });

  it("is case insensitive and matches metadata file names", () => {
    expect(isIgnoredPath("Notes/@EADIR/x.md")).toBe(true);
    expect(isIgnoredPath("Notes/Thumbs.db")).toBe(true);
    expect(isIgnoredPath("notes/.synotmb.tmp")).toBe(true);
  });
});

describe("extension classification", () => {
  it("treats Office and OpenDocument containers as binary", () => {
    for (const ext of ["pdf", "docx", "xlsx", "pptx", "odp", "ods", "oslides", "epub", "rtf"])
      expect(BINARY_EXTS.has(ext)).toBe(true);
  });

  it("treats disk images and dumps as binary", () => {
    for (const ext of ["iso", "img", "dmg", "qcow2", "vmdk", "dump", "sqlite", "pcapng"])
      expect(BINARY_EXTS.has(ext)).toBe(true);
  });

  it("treats unrenderable image formats as binary", () => {
    // These would fail in the Chromium canvas path, so they come back as base64.
    for (const ext of ["heic", "heif", "avif", "ico", "psd", "xcf", "sketch"])
      expect(BINARY_EXTS.has(ext)).toBe(true);
  });

  it("keeps note formats out of the binary list", () => {
    for (const ext of ["md", "txt", "json", "yaml", "canvas", "csv", "svg", "ts"])
      expect(BINARY_EXTS.has(ext)).toBe(false);
  });

  it("classifies an extension into one bucket", () => {
    expect(classifyExtension("png")).toBe("image");
    expect(classifyExtension("svg")).toBe("text");
    expect(classifyExtension(".PDF")).toBe("binary");
    expect(classifyExtension("note")).toBe("unknown");
    expect(IMAGE_EXTS.has("heic")).toBe(false);
  });
  it("keeps text-based 3D formats readable and binary containers opaque", () => {
    // obj and gltf are JSON/plain text; glb is their binary container.
    expect(BINARY_EXTS.has("obj")).toBe(false);
    expect(BINARY_EXTS.has("gltf")).toBe(false);
    expect(BINARY_EXTS.has("glb")).toBe(true);
  });
});

describe("scan and read size limits", () => {
  it("never opens a known binary or oversize file", () => {
    const iso = shouldScanContent("course/SERVER_EVAL_x64_en-us.iso", "iso", 4.8 * 1024 * 1024 * 1024);
    expect(iso.scan).toBe(false);
    expect(["binary", "too_large"]).toContain(iso.reason);

    const bigNote = shouldScanContent("notes/huge.md", "md", 40 * 1024 * 1024);
    expect(bigNote.scan).toBe(false);
    expect(bigNote.reason).toBe("too_large");

    const metadata = shouldScanContent("#recycle/old.md", "md", 512);
    expect(metadata.scan).toBe(false);
    expect(metadata.reason).toBe("ignored");

    expect(shouldScanContent("notes/ok.md", "md", 1024).scan).toBe(true);
  });

  it("checks size before the extension so big files are never touched", () => {
    // An unknown extension at 900 MB is rejected on size alone.
    const decision = shouldScanContent("backups/mystery", "mystery", 900 * 1024 * 1024);
    expect(decision.scan).toBe(false);
    expect(decision.reason).toBe("too_large");
  });

  it("keeps the budgets inside the documented limits", () => {
    expect(MAX_SCAN_FILE_BYTES).toBeLessThan(MAX_TEXT_BYTES);
    expect(formatMegabytes(MAX_SCAN_FILE_BYTES)).toBe("2.0 MB");
    expect(formatMegabytes(MAX_TEXT_BYTES)).toBe("5.0 MB");
  });

  it("leaves room between the search deadline and the 25 s tool timeout", () => {
    // The timeout turns the call into an error with no results at all, so the
    // scan must be able to stop well before it, even with a slow batch.
    expect(SEARCH_DEADLINE_MS).toBeLessThanOrEqual(20_000);
    expect(MAX_SCAN_TOTAL_BYTES).toBe(32 * 1024 * 1024);
  });
});
