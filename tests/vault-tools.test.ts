import { describe, it, expect } from "vitest";

// ── Test helpers from vault-tools (standalone logic extracted) ─────────────

const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp","tiff","tif"]);
const SVG_EXTS   = new Set(["svg"]);
const BINARY_EXTS = new Set([
  "pdf","docx","xlsx","pptx","zip","rar","7z","gz","tar",
  "mp3","mp4","wav","ogg","flac","avi","mkv","mov","wmv",
  "exe","dll","so","dylib","wasm",
  "sqlite","db",
  "ttf","otf","woff","woff2","eot",
]);

function maxDimForSize(bytes: number): number {
  if (bytes > 100 * 1024 * 1024) return 512;
  if (bytes >  20 * 1024 * 1024) return 800;
  return 1024;
}

function mimeType(ext: string): string {
  const t: Record<string, string> = {
    png:  "image/png",    jpg:  "image/jpeg",  jpeg: "image/jpeg",
    gif:  "image/gif",    webp: "image/webp",  svg:  "image/svg+xml",
    bmp:  "image/bmp",    tiff: "image/tiff",  tif:  "image/tiff",
    pdf:  "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip:  "application/zip",
    mp3:  "audio/mpeg",   mp4:  "video/mp4",   wav:  "audio/wav",
  };
  return t[ext.toLowerCase()] ?? "application/octet-stream";
}

function formatBytes(n: number): string {
  if (n < 1024)         return `${n} bytes`;
  if (n < 1024 * 1024)  return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function validatePath(p: unknown): string {
  if (typeof p !== "string" || p.length === 0)
    throw new Error("'path' must be a non-empty string");
  if (p.length > 1000)
    throw new Error("'path' is too long (max 1000 chars)");
  if (p.startsWith("/"))
    throw new Error("'path' must be vault-relative (no leading slash or drive letter)");
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === ".."))
    throw new Error("'path' must not traverse outside the vault (no '..')");
  return p;
}

// ── Glob matching (from mcp-server.ts) ─────────────────────────────────────

function globMatch(pattern: string, cmd: string): boolean {
  if (pattern === "*") return true;
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    + "$";
  return new RegExp(regexStr, "i").test(cmd.trim());
}

function isCommandAllowed(cmd: string, patterns: string): string | null {
  if (!patterns || patterns === "*") return null;
  const cmds = cmd.trim().split(/\s+/);
  const firstToken = cmds[0] || "";
  for (const pattern of patterns.split(",")) {
    const p = pattern.trim();
    if (!p) continue;
    if (globMatch(p, cmd.trim()) || globMatch(p, firstToken)) return null;
  }
  return `Command '${firstToken}' is not in the allowed list.`;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("maxDimForSize", () => {
  it("returns 1024 for files <= 20 MB", () => {
    expect(maxDimForSize(0)).toBe(1024);
    expect(maxDimForSize(1_000_000)).toBe(1024);
    expect(maxDimForSize(20 * 1024 * 1024)).toBe(1024);
  });

  it("returns 800 for files 20-100 MB", () => {
    expect(maxDimForSize(21 * 1024 * 1024)).toBe(800);
    expect(maxDimForSize(50 * 1024 * 1024)).toBe(800);
    expect(maxDimForSize(100 * 1024 * 1024)).toBe(800);
  });

  it("returns 512 for files > 100 MB", () => {
    expect(maxDimForSize(101 * 1024 * 1024)).toBe(512);
    expect(maxDimForSize(500 * 1024 * 1024)).toBe(512);
  });
});

describe("mimeType", () => {
  it("returns correct MIME types for known extensions", () => {
    expect(mimeType("png")).toBe("image/png");
    expect(mimeType("jpg")).toBe("image/jpeg");
    expect(mimeType("jpeg")).toBe("image/jpeg");
    expect(mimeType("gif")).toBe("image/gif");
    expect(mimeType("webp")).toBe("image/webp");
    expect(mimeType("svg")).toBe("image/svg+xml");
    expect(mimeType("pdf")).toBe("application/pdf");
    expect(mimeType("mp4")).toBe("video/mp4");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(mimeType("xyz")).toBe("application/octet-stream");
    expect(mimeType("")).toBe("application/octet-stream");
  });

  it("is case-insensitive", () => {
    expect(mimeType("PNG")).toBe("image/png");
    expect(mimeType("PDF")).toBe("application/pdf");
  });
});

describe("formatBytes", () => {
  it("formats bytes correctly", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(500)).toBe("500 bytes");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_048_576)).toBe("1 MB");
    expect(formatBytes(5_242_880)).toBe("5 MB");
  });
});

describe("validatePath", () => {
  it("accepts valid paths", () => {
    expect(validatePath("Notes/idea.md")).toBe("Notes/idea.md");
    expect(validatePath("file.txt")).toBe("file.txt");
    expect(validatePath("a/b/c/d/e.md")).toBe("a/b/c/d/e.md");
  });

  it("rejects empty path", () => {
    expect(() => validatePath("")).toThrow("non-empty string");
  });

  it("rejects non-string path", () => {
    // @ts-expect-error testing invalid input
    expect(() => validatePath(123)).toThrow("non-empty string");
    // @ts-expect-error testing invalid input
    expect(() => validatePath(null)).toThrow("non-empty string");
  });

  it("rejects path traversal (..)", () => {
    expect(() => validatePath("../etc/passwd")).toThrow("no '..'");
    expect(() => validatePath("safe/../../etc")).toThrow("no '..'");
  });

  it("rejects paths with leading slash", () => {
    expect(() => validatePath("/etc/passwd")).toThrow("leading slash");
  });

  it("rejects overly long paths", () => {
    expect(() => validatePath("a".repeat(1001))).toThrow("too long");
  });
});

describe("globMatch", () => {
  it("matches wildcard to everything", () => {
    expect(globMatch("*", "anything here")).toBe(true);
  });

  it("matches exact commands", () => {
    expect(globMatch("node", "node")).toBe(true);
    expect(globMatch("node", "nodejs")).toBe(false);
  });

  it("matches prefix patterns", () => {
    expect(globMatch("node *", "node script.js")).toBe(true);
    expect(globMatch("node *", "node --version")).toBe(true);
    expect(globMatch("node *", "nodemon")).toBe(false);
  });

  it("matches multiple word patterns", () => {
    expect(globMatch("python *", "python3")).toBe(false);
    expect(globMatch("Git *", "git status")).toBe(true);
  });
});

describe("isCommandAllowed", () => {
  it("allows everything with wildcard", () => {
    expect(isCommandAllowed("rm -rf /", "*")).toBeNull();
    expect(isCommandAllowed("rm -rf /", "")).toBeNull();
  });

  it("blocks commands not in allowlist", () => {
    expect(isCommandAllowed("rm -rf /", "node *, python *")).toBeTruthy();
  });

  it("allows commands matching any pattern", () => {
    expect(isCommandAllowed("node server.js", "node *, python *")).toBeNull();
    expect(isCommandAllowed("python train.py", "node *, python *")).toBeNull();
  });

  it("handles comma-separated patterns", () => {
    expect(isCommandAllowed("git push", "git *, node *")).toBeNull();
    expect(isCommandAllowed("ls -la", "git *, node *")).toBeTruthy();
  });
});

describe("image extension sets", () => {
  it("contains all expected image extensions", () => {
    expect(IMAGE_EXTS.has("png")).toBe(true);
    expect(IMAGE_EXTS.has("jpg")).toBe(true);
    expect(IMAGE_EXTS.has("jpeg")).toBe(true);
    expect(IMAGE_EXTS.has("gif")).toBe(true);
    expect(IMAGE_EXTS.has("webp")).toBe(true);
    expect(IMAGE_EXTS.has("svg")).toBe(false); // SVG is text
  });

  it("contains SVG separately", () => {
    expect(SVG_EXTS.has("svg")).toBe(true);
  });
});

describe("binary extension sets", () => {
  it("contains expected binary extensions", () => {
    expect(BINARY_EXTS.has("pdf")).toBe(true);
    expect(BINARY_EXTS.has("docx")).toBe(true);
    expect(BINARY_EXTS.has("mp4")).toBe(true);
    expect(BINARY_EXTS.has("zip")).toBe(true);
    expect(BINARY_EXTS.has("exe")).toBe(true);
  });

  it("does not contain text extensions", () => {
    expect(BINARY_EXTS.has("md")).toBe(false);
    expect(BINARY_EXTS.has("txt")).toBe(false);
    expect(BINARY_EXTS.has("json")).toBe(false);
    expect(BINARY_EXTS.has("yaml")).toBe(false);
    expect(BINARY_EXTS.has("css")).toBe(false);
  });
});
