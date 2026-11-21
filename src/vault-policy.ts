import * as nodePath from "node:path";

// ── scan and size policy ───────────────────────────────────────────────────
//
// Pure helpers with no Obsidian dependency: a vault can mirror a Drive or NAS
// folder, and reading one large media file as text is enough to stall the
// Obsidian renderer. Every walk and read path goes through the checks below.
// This module is imported directly by the tests (see tests/vault-policy.test.ts).

// Directories that are never note content: Synology metadata and recycle
// bins, Obsidian workspace state, VCS internals, editor junk. Obsidian already
// hides dot-prefixed folders, but `#recycle` and `@eaDir` are not hidden.
const IGNORED_DIR_NAMES = new Set([
  "#recycle", "@eadir", ".trash", ".trashes", ".obsidian",
  ".git", ".svn", ".hg", "node_modules", ".ds_store", "thumbs.db",
]);

const IGNORED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const IGNORED_FILE_PREFIXES = ["@eaDir", ".synotmb", ".syno", "#snapshot"];

// Known binary extensions that should never be attempted as text. Formats that
// Chromium cannot render (heic, ico, psd, …) are binary, not images: they come
// back as base64 instead of failing in the canvas resize path.
export const BINARY_EXTS = new Set([
  "pdf","docx","xlsx","pptx","doc","xls","ppt","odt","ods","odp","odg",
  "odb","oslides","rtf","epub","numbers","pages","key",
  "zip","rar","7z","gz","bz2","xz","tar","tgz","zst","iso","img","dmg",
  "wim","vhd","vhdx","qcow2","vmdk","bin","dump","pkg","deb","rpm","apk",
  "msi","exe","dll","so","dylib","wasm","jar","class",
  "ico","heic","heif","avif","psd","xcf","ai","sketch","fig","kra",
  "mp3","mp4","m4a","m4v","wav","ogg","opus","flac","aac","avi","mkv",
  "mov","wmv","webm","flv","mpg","mpeg","3gp",
  "blend","fbx","glb","stl",
  "sqlite","sqlite3","db","ttf","otf","woff","woff2","eot",
  "pcap","pcapng",
]);

// Image formats the plugin can render through the Chromium canvas.
export const IMAGE_EXTS = new Set([
  "png","jpg","jpeg","gif","webp","bmp","tiff","tif",
]);

// Largest single file `search` will open. Notes are far below this; anything
// bigger is a media or data file that must not be decoded as text.
export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

// Largest file `read_file` returns as text. Beyond this the answer would not
// fit a useful context window anyway.
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

// Largest binary payload `read_file` returns as base64, and the largest body
// `write_binary` accepts. One number for both directions, so a client can rely
// on "anything I can read I can also write back".
export const MAX_BINARY_BYTES = 32 * 1024 * 1024;

// Total bytes one `search` call may read across all files. Enforced by
// reserving bytes before each read (listed size, topped up to the current
// size), so the ceiling holds even when every listed size was stale.
export const MAX_SCAN_TOTAL_BYTES = 32 * 1024 * 1024;

// Wall-clock budget for one search, kept well under the 25 s tool timeout so
// the caller receives partial results instead of a timeout error.
export const SEARCH_DEADLINE_MS = 15_000;

// Wall-clock budget for one `read_file` disk read. It has to end before the
// 25 s tool timeout with room for the response to be built.
export const READ_DEADLINE_MS = 10_000;

/** True when any path segment is metadata or index noise. */
export function isIgnoredPath(path: string): boolean {
  for (const segment of path.split(/[/\\]/)) {
    if (!segment) continue;
    const lower = segment.toLowerCase();
    if (IGNORED_DIR_NAMES.has(lower) || IGNORED_FILE_NAMES.has(lower)) return true;
    for (const prefix of IGNORED_FILE_PREFIXES) {
      if (lower.startsWith(prefix.toLowerCase())) return true;
    }
  }
  return false;
}

export type FileClass = "image" | "binary" | "text" | "unknown";

/** Classifies by extension. Unknown extensions fall back to the size checks. */
export function classifyExtension(ext: string): FileClass {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "svg") return "text";
  if (IMAGE_EXTS.has(e)) return "image";
  if (BINARY_EXTS.has(e)) return "binary";
  return "unknown";
}

export type ScanDecision = { scan: boolean; reason?: "ignored" | "binary" | "too_large" };

/**
 * Decide whether a file may be opened for content search. Size is checked
 * before the extension so an oversized file is never touched at all.
 */
export function shouldScanContent(path: string, ext: string, sizeBytes: number): ScanDecision {
  if (isIgnoredPath(path)) return { scan: false, reason: "ignored" };
  if (sizeBytes > MAX_SCAN_FILE_BYTES) return { scan: false, reason: "too_large" };
  const cls = classifyExtension(ext);
  if (cls === "binary" || cls === "image") return { scan: false, reason: "binary" };
  return { scan: true };
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── vault path validation ───────────────────────────────────────────────────
//
// Validation lives in the file layer, not only at the MCP boundary: a caller
// that reaches VaultTools directly must get the same guarantees. The MCP server
// keeps its own check as a fast, early rejection.

export const MAX_PATH_LEN = 1000;

export class VaultPathError extends Error {}

/** Rejects anything that is not a safe vault-relative path. */
export function validateVaultPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new VaultPathError("'path' must be a non-empty string");
  if (value.length > MAX_PATH_LEN)
    throw new VaultPathError(`'path' is too long (max ${MAX_PATH_LEN} chars)`);
  if (value.includes("\0"))
    throw new VaultPathError("'path' must not contain null bytes");
  if (nodePath.isAbsolute(value) || value.startsWith("\\") || /^[A-Za-z]:/.test(value))
    throw new VaultPathError("'path' must be vault-relative (no leading slash or drive letter)");
  if (value.split(/[/\\]/).some(segment => segment === ".."))
    throw new VaultPathError("'path' must not traverse outside the vault (no '..')");
  return value;
}

// ── base64 payload validation ───────────────────────────────────────────────

export type Base64Check = { ok: true; estimatedBytes: number } | { ok: false; reason: string };

/**
 * Validates a base64 payload **before** it is decoded. `Buffer.from(x, "base64")`
 * silently discards characters outside the alphabet, so an unvalidated payload
 * can be much larger than the size estimate, or be garbage that is written into
 * the vault anyway.
 */
export function validateBase64Payload(payload: unknown, maxDecodedBytes: number): Base64Check {
  if (typeof payload !== "string" || payload.length === 0)
    return { ok: false, reason: "'base64Data' must be a non-empty string" };
  if (/\s/.test(payload))
    return { ok: false, reason: "'base64Data' must not contain whitespace or line breaks" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
    return { ok: false, reason: "'base64Data' contains characters outside the base64 alphabet" };
  if (payload.length % 4 !== 0)
    return { ok: false, reason: "'base64Data' length must be a multiple of 4" };

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const estimatedBytes = (payload.length / 4) * 3 - padding;
  if (estimatedBytes > maxDecodedBytes)
    return {
      ok: false,
      reason: `data is too large (${formatMegabytes(estimatedBytes)} decoded, limit ${formatMegabytes(maxDecodedBytes)})`,
    };

  return { ok: true, estimatedBytes };
}
