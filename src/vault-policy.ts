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

// Total bytes one `search` call may read across all files. Batches are sized to
// this budget from the file list, so a call never reads more than it plus one
// file's worth of rounding.
export const MAX_SCAN_TOTAL_BYTES = 32 * 1024 * 1024;

// Wall-clock budget for one search, kept well under the 25 s tool timeout so
// the caller receives partial results instead of a timeout error.
export const SEARCH_DEADLINE_MS = 15_000;

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
