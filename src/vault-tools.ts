import { App, TFile, parseYaml } from "obsidian";
import * as nodePath from "node:path";
import { localFileUrl } from "./runtime-files";
import {
  BINARY_EXTS,
  IMAGE_EXTS,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_TOTAL_BYTES,
  MAX_TEXT_BYTES,
  MAX_BINARY_BYTES,
  READ_DEADLINE_MS,
  SEARCH_DEADLINE_MS,
  formatMegabytes,
  isIgnoredPath,
  shouldScanContent,
  validateBase64Payload,
  validateVaultPath,
} from "./vault-policy";
import {
  realPathNative,
  runContentScan,
  isSameOrInside,
  readBoundedBinary,
  readBoundedFile,
} from "./vault-scan";

// ── extension sets ────────────────────────────────────────────────────────
// Image and binary extension sets, plus the scan and read size limits, live in
// vault-policy.ts: that module has no Obsidian dependency, so the unit tests
// import it directly instead of keeping a second copy of the rules.
const SVG_EXTS = new Set(["svg"]);

// Threshold below which images are sent as-is (bytes)
const RESIZE_THRESHOLD = 4 * 1024 * 1024; // 4 MB

// Maximum file size for binary read/write operations. Base64 costs about 4/3
// of this in a single string plus the same again in Buffer.from, so a big
// enough file is still fatal even when the size check fires. The Docker
// sibling project uses the same 32 MB limit for the same reason.
// The base64 read/write ceiling is MAX_BINARY_BYTES from vault-policy: one
// number for both directions, shared with the MCP layer.

/** Wraps a text read so an unexpectedly large decode is rejected, not returned. */
function asText(content: string): ReadFileResult {
  const decodedBytes = Buffer.byteLength(content);
  if (decodedBytes > MAX_TEXT_BYTES)
    throw new Error(
      `File is too large to read as text (${formatMegabytes(decodedBytes)} decoded, limit ${formatMegabytes(MAX_TEXT_BYTES)}). ` +
      "Use run_local_command with grep/head to inspect it."
    );
  return { type: "text", content };
}

// Tiered max-dimension based on file size
function maxDimForSize(bytes: number): number {
  if (bytes > 100 * 1024 * 1024) return 512;
  if (bytes >  20 * 1024 * 1024) return 800;
  return 1024;
}

// Hard timeout for Canvas decode + resize (ms)
const CANVAS_TIMEOUT_MS = 15_000;

// ── mime ──────────────────────────────────────────────────────────────────
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

// ── helpers ───────────────────────────────────────────────────────────────
function getFile(app: App, path: string): TFile | null {
  // Defend against symlink traversal — resolve & verify before accessing
  resolveVaultPath(app, path);
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

/**
 * The vault as one normalized absolute directory. Native realpath is the only
 * spelling that agrees with how the OS resolves a link inside the vault: the
 * adapter base can arrive as the Windows 8.3 short form
 * (`C:\\Users\\RUNNER~1\\...`) while a resolved link comes back long
 * (`C:\\Users\\runneradmin\\...`). It also handles a vault that sits behind a
 * link, such as iCloud Drive or a junctioned workspace.
 */
async function getVaultRoot(app: App): Promise<string> {
  const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
  const base = adapter.basePath ?? adapter.getBasePath?.() ?? "";
  return base ? realPathNative(base) : "";
}

/**
 * Resolve the real path & verify it's inside the vault.
 * Prevents symlink-based path traversal (e.g. a symlink pointing to /etc).
 */
/**
 * Resolve a vault-relative path to an absolute path, and verify it stays inside
 * the vault.
 *
 * Validation is centralized here, in the file layer, and not only at the MCP
 * boundary: the type, length, null-byte, drive-letter and `..` checks run for
 * every caller, including one that reaches these tools directly. The containment
 * check requires a real separator, so a sibling such as `/vault-evil` never
 * counts as being inside `/vault`.
 */
function resolveVaultPath(app: App, vaultRelativePath: string): string {
  const safePath = validateVaultPath(vaultRelativePath);
  const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
  const vaultBase = adapter.basePath ?? adapter.getBasePath?.() ?? "";
  const resolved = nodePath.resolve(vaultBase, safePath);
  if (!isSameOrInside(vaultBase, resolved)) {
    throw new Error(`Path traversal detected: '${vaultRelativePath}' resolves outside the vault`);
  }
  return resolved;
}

/**
 * Resize via Electron/Chromium Canvas API.
 */
function resizeImageCanvas(
  absPath: string,
  maxDim: number
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  const fileUrl = localFileUrl(absPath);

  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      done(() => {
        img.src = "";
        reject(new Error(
          `Canvas decode timeout after ${CANVAS_TIMEOUT_MS / 1000} s — ` +
          `file may be too large or in an unsupported format`
        ));
      });
    }, CANVAS_TIMEOUT_MS);

    img.onload = () => done(() => {
      try {
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        if (w === 0 || h === 0) {
          reject(new Error("Image has zero dimensions — unsupported format"));
          return;
        }

        if (w > maxDim || h > maxDim) {
          if (w >= h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else        { w = Math.round((w * maxDim) / h); h = maxDim; }
        }

        const canvas = document.createElement("canvas");
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas 2D context unavailable")); return; }

        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ data: dataUrl.split(",")[1], mimeType: "image/jpeg", width: w, height: h });
      } catch (e) {
        reject(e);
      }
    });

    img.onerror = () => done(() =>
      reject(new Error(`Chromium could not decode image: ${absPath}`))
    );

    img.src = fileUrl;
  });
}

// ── tool implementations ──────────────────────────────────────────────────

export async function toolListFiles(app: App, folder = "", extension = "", limit = 2000) {
  const all = app.vault.getFiles();
  // NAS and sync metadata is not note content; `@eaDir` and `#recycle` are not
  // hidden by Obsidian, so they show up here without this filter.
  const visible = all.filter(f => !isIgnoredPath(f.path));
  let files = visible;
  if (folder)
    files = files.filter(f =>
      f.path.startsWith(folder.replace(/\/$/, "") + "/") || f.path === folder
    );
  if (extension) {
    const ext = extension.replace(/^\./, "").toLowerCase();
    files = files.filter(f => f.extension.toLowerCase() === ext);
  }
  const total = files.length;
  const page  = files.slice(0, limit);
  const skipped = all.length - visible.length;
  return {
    files: page.map(f => ({
      path:      f.path,
      name:      f.name,
      extension: f.extension,
      size:      f.stat.size,
      modified:  new Date(f.stat.mtime).toISOString(),
    })),
    total,
    shown:     page.length,
    truncated: total > limit,
    ...(skipped > 0 && { skipped_metadata: skipped }),
    ...(total > limit && { note: `Showing ${limit} of ${total} files. Use folder or extension filters to narrow results.` }),
  };
}

export type ReadFileResult =
  | { type: "text";   content: string }
  | { type: "image";  mimeType: string; data: string; note?: string }
  | { type: "binary"; mimeType: string; data: string; size: number };

/**
 * True when Obsidian holds this file open in an editor. Such a file already has
 * its full content in memory, and only Obsidian's cache can show unsaved edits,
 * so reading it through the vault cannot allocate anything unbounded.
 */
function isOpenInEditor(app: App, path: string): boolean {
  const workspace = app.workspace as unknown as { getFiles?: () => { path: string }[] };
  return (workspace.getFiles?.() ?? []).some(open => open.path === path);
}

function readFailureMessage(
  file: TFile,
  read: { size?: number; tooLarge?: boolean; cancelled?: boolean },
  phrase: string,
  capBytes: number,
  suffix: string
): string {
  const actual = read.size ?? file.stat.size;
  if (read.cancelled)
    return `Reading ${file.path} did not finish within ${READ_DEADLINE_MS / 1000}s. The file may be on a slow or unavailable mount.`;
  if (read.tooLarge)
    return `${phrase} (${formatMegabytes(actual)}, limit ${formatMegabytes(capBytes)}). ${suffix}`;
  return `Could not read ${file.path}`;
}

/**
 * Text for `read_file`, with the cap enforced by the reader itself.
 *
 * The previous code checked the size reported by the vault listing and then
 * called `vault.read`, which allocates whatever the file is **now**: a file that
 * grew after the listing was taken was decoded in full before anyone could
 * notice. Here the disk read goes through bounded chunks, so at most `capBytes`
 * is allocated and the size that counts is the one taken from the open handle.
 *
 * Files open in an editor keep using Obsidian's cache, which is the only place
 * unsaved edits exist and which is already in memory.
 */
async function readTextForResponse(
  app: App,
  file: TFile,
  absPath: string,
  vaultRoot: string,
  capBytes: number,
  label: string,
  suffix: string
): Promise<string> {
  if (!vaultRoot || isOpenInEditor(app, file.path)) {
    const text = await app.vault.read(file);
    const decoded = Buffer.byteLength(text);
    if (decoded > capBytes)
      throw new Error(
        `${label} is too large to return as text (${formatMegabytes(decoded)}, limit ${formatMegabytes(capBytes)}). ${suffix}`
      );
    return text;
  }

  const read = await readBoundedFile(absPath, vaultRoot, capBytes, Date.now() + READ_DEADLINE_MS);
  if (read.text === undefined)
    throw new Error(readFailureMessage(file, read, `${label} is too large to return as text`, capBytes, suffix));
  return read.text;
}

/** Same guarantee for bytes: at most `capBytes` are ever allocated. */
async function readBinaryForResponse(
  file: TFile,
  absPath: string,
  vaultRoot: string,
  capBytes: number,
  suffix: string
): Promise<{ data: Buffer; size: number }> {
  const read = await readBoundedBinary(absPath, vaultRoot, capBytes, Date.now() + READ_DEADLINE_MS);
  if (!read.data)
    throw new Error(readFailureMessage(file, read, "File too large to return as base64", capBytes, suffix));
  return { data: read.data, size: read.bytes };
}

export async function toolReadFile(app: App, path: string): Promise<ReadFileResult> {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);

  const ext       = file.extension.toLowerCase();
  const bytes     = file.stat.size;   // listing size: only picks the branch
  const vaultRoot = await getVaultRoot(app);
  const absPath   = nodePath.join(vaultRoot, file.path);

  // ── SVG → text ────────────────────────────────────────────────────────
  if (SVG_EXTS.has(ext)) {
    const text = await readTextForResponse(
      app, file, absPath, vaultRoot, MAX_TEXT_BYTES, "SVG",
      "Use run_local_command to inspect it, or read the image it embeds."
    );
    return asText(text);
  }

  // ── Raster images — always return as viewable image ───────────────────
  if (IMAGE_EXTS.has(ext)) {
    const mime = mimeType(ext);

    // The listing decides nothing here. The bounded reader reports the real
    // size: under the inline limit the bytes go back as they are, above it the
    // resize path uses the size that was actually measured. A photo that grew
    // after the listing was taken is therefore neither buffered whole nor sent
    // through the canvas with the wrong tier.
    const probe = await readBoundedBinary(
      absPath, vaultRoot, RESIZE_THRESHOLD, Date.now() + READ_DEADLINE_MS
    );
    if (probe.data) return { type: "image", mimeType: mime, data: probe.data.toString("base64") };
    if (!probe.tooLarge)
      throw new Error(readFailureMessage(
        file, probe, "Image too large to return as base64", RESIZE_THRESHOLD,
        "Use run_local_command to inspect it, or fetch it from the server's /raw endpoint."
      ));

    const actual  = probe.size ?? bytes;
    const actualMB = formatMegabytes(actual);
    const maxDim  = maxDimForSize(actual);
    try {
      const resized = await resizeImageCanvas(absPath, maxDim);
      const note = `[Auto-resized: original ${actualMB} → ${resized.width}×${resized.height} JPEG 85%]`;
      return { type: "image", mimeType: resized.mimeType, data: resized.data, note };
    } catch (err) {
      throw new Error(
        `Could not process image (${actualMB}): ` +
        (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // ── Known binary — return base64 with metadata ────────────────────────
  if (BINARY_EXTS.has(ext)) {
    const bin = await readBinaryForResponse(
      file, absPath, vaultRoot, MAX_BINARY_BYTES,
      "Use run_local_command to inspect it, or fetch it from the server's /raw endpoint."
    );
    return { type: "binary", mimeType: mimeType(ext), data: bin.data.toString("base64"), size: bin.size };
  }

  // ── Everything else — text within the limit, base64 above it ──────────
  //
  // Without these checks an unknown extension (`.sql`, `.dump`, a course `.iso`
  // copied into the vault) is decoded as text and can freeze the renderer.
  // One bounded read up to the base64 cap decides the shape, and it decides
  // from the size read off the open handle: the listing may be too small (a
  // file that grew) or too large (a file that was truncated since).
  if (isOpenInEditor(app, file.path) && bytes <= MAX_TEXT_BYTES) {
    const text = await readTextForResponse(
      app, file, absPath, vaultRoot, MAX_TEXT_BYTES, "File",
      "Use run_local_command with grep/head to inspect it."
    );
    return asText(text);
  }

  const bin = await readBinaryForResponse(
    file, absPath, vaultRoot, MAX_BINARY_BYTES,
    "Use run_local_command to inspect it, or fetch it from the server's /raw endpoint."
  );
  if (bin.size > MAX_TEXT_BYTES)
    return { type: "binary", mimeType: mimeType(ext), data: bin.data.toString("base64"), size: bin.size };

  // asText re-checks the decoded length: bytes counted on disk are bytes here.
  return asText(bin.data.toString("utf-8"));
}

export async function toolWriteFile(app: App, path: string, content: string) {
  const existing = getFile(app, path);
  if (existing) {
    await app.vault.modify(existing, content);
    return { path, action: "updated" };
  }
  const parts = path.split("/");
  if (parts.length > 1) {
    const dir = parts.slice(0, -1).join("/");
    try { await app.vault.createFolder(dir); } catch { /* already exists */ }
  }
  await app.vault.create(path, content);
  return { path, action: "created" };
}

export async function toolWriteBinary(app: App, path: string, base64Data: string) {
  // Validated before anything is decoded. `Buffer.from(x, "base64")` silently
  // drops characters outside the alphabet, so an unvalidated body can decode to
  // far more than the size estimate, or be garbage that is written into the
  // vault anyway.
  const payload = validateBase64Payload(base64Data, MAX_BINARY_BYTES);
  if (!payload.ok) throw new Error(`Data cannot be written: ${payload.reason}`);

  const buf = Buffer.from(base64Data, "base64");
  // Round-trip check: the estimate and the real decode must agree.
  if (buf.length !== payload.estimatedBytes)
    throw new Error(
      `Data cannot be written: 'base64Data' decoded to ${buf.length} bytes, expected ${payload.estimatedBytes}`
    );
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const existing = getFile(app, path);
  if (existing) {
    await app.vault.modifyBinary(existing, arrayBuf);
    return { path, action: "updated", size: buf.length };
  }
  const parts = path.split("/");
  if (parts.length > 1) {
    const dir = parts.slice(0, -1).join("/");
    try { await app.vault.createFolder(dir); } catch { /* already exists */ }
  }
  await app.vault.createBinary(path, arrayBuf);
  return { path, action: "created", size: buf.length };
}

export async function toolDeleteFile(app: App, path: string) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  await app.vault.trash(file, true);
  return { path, action: "deleted" };
}

// ── Frontmatter tools ──────────────────────────────────────────────────────

// Leading YAML block. Accepts CRLF and an empty block ("---\n---").
const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;

export async function toolReadFrontmatter(app: App, path: string) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  const content = await app.vault.read(file);
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) return { path, hasFrontmatter: false, frontmatter: {}, raw: null };
  const raw = fmMatch[1] ?? "";
  // Use Obsidian's YAML parser so lists, nested values, and quoted strings survive.
  let parsed: unknown;
  try {
    parsed = raw.trim() ? parseYaml(raw) : {};
  } catch (err) {
    throw new Error(`Invalid YAML frontmatter in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return { path, hasFrontmatter: true, frontmatter, raw };
}

export async function toolUpdateFrontmatter(app: App, path: string, updates: Record<string, unknown>) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  // processFrontMatter is documented since Obsidian 1.4.4. Refuse on older
  // versions instead of falling back to a lossy hand-written YAML rewrite.
  if (typeof app.fileManager?.processFrontMatter !== "function")
    throw new Error("update_frontmatter requires Obsidian 1.4.4 or newer");

  const content = await app.vault.read(file);
  if (!FRONTMATTER_RE.test(content) && Object.values(updates).every(v => v === null))
    return { path, action: "unchanged" };

  // Obsidian parses and re-serializes the whole block, so keys this call does
  // not touch (lists, nested maps, hyphenated names) are preserved.
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    for (const [key, val] of Object.entries(updates)) {
      if (val === null) delete frontmatter[key];
      else frontmatter[key] = val;
    }
  });
  return { path, action: "frontmatter_updated" };
}

// ── Folder tools ────────────────────────────────────────────────────────────

export async function toolCreateFolder(app: App, path: string) {
  const safePath = validateVaultPath(path);
  try {
    await app.vault.createFolder(safePath);
    return { path: safePath, action: "folder_created" };
  } catch (err) {
    // Folder likely already exists — not an error
    return { path: safePath, action: "already_exists" };
  }
}

export async function toolDeleteFolder(app: App, path: string) {
  const safePath = validateVaultPath(path);
  const folder = app.vault.getAbstractFileByPath(safePath);
  if (!folder || folder instanceof TFile)
    throw new Error(`Folder not found: ${safePath}`);
  await app.vault.trash(folder, true);
  return { path: safePath, action: "folder_deleted" };
}

export async function toolRenameFolder(app: App, path: string, newPath: string) {
  // Centralized in the file layer: type, length, null bytes, absolute paths,
  // drive letters and `..` segments, for both the source and the destination.
  const safePath = validateVaultPath(path);
  const safeNewPath = validateVaultPath(newPath);
  const folder = app.vault.getAbstractFileByPath(safePath);
  if (!folder || folder instanceof TFile)
    throw new Error(`Folder not found: ${safePath}`);
  await app.vault.rename(folder, safeNewPath);
  return { path: safePath, newPath: safeNewPath, action: "folder_renamed" };
}

// ── Append tool ─────────────────────────────────────────────────────────────

export async function toolAppendFile(app: App, path: string, content: string) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  const existing = await app.vault.read(file);
  await app.vault.modify(file, existing + content);
  return { path, action: "appended", totalSize: (existing.length + content.length) };
}

export async function toolSearch(app: App, query: string) {
  const q = query.toLowerCase();
  const results: { path: string; matches: string[] }[] = [];
  const MAX_RESULTS = 50;
  const CONCURRENCY = 20;
  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;
  const allFiles = app.vault.getFiles();

  // Filename matches first (no I/O)
  for (const file of allFiles) {
    if (results.length >= MAX_RESULTS) break;
    if (isIgnoredPath(file.path)) continue;
    if (file.path.toLowerCase().includes(q))
      results.push({ path: file.path, matches: ["(filename match)"] });
  }

  // Content candidates are chosen from the file list, before anything is
  // opened: metadata folders, binary and image formats, and files over the
  // per-file cap must never be decoded.
  const matched = new Set(results.map(r => r.path));
  const candidates: TFile[] = [];
  let skippedMetadata = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  for (const file of allFiles) {
    if (matched.has(file.path)) continue;
    const decision = shouldScanContent(file.path, file.extension, file.stat.size);
    if (decision.scan) candidates.push(file);
    else if (decision.reason === "too_large") skippedTooLarge++;
    else if (decision.reason === "binary") skippedBinary++;
    else skippedMetadata++;
  }

  const byPath = new Map(candidates.map(f => [f.path, f]));
  const vaultRoot = await getVaultRoot(app);
  const adapter = app.vault.adapter as {
    stat?: (path: string) => Promise<{ size?: number } | null>;
  };

  const summary = await runContentScan(
    candidates.map(f => ({ path: f.path, declaredSize: f.stat.size })),
    {
      perFileBytes: MAX_SCAN_FILE_BYTES,
      maxTotalBytes: MAX_SCAN_TOTAL_BYTES,
      concurrency: CONCURRENCY,
      deadlineAt,
      stat: async item => {
        const file = byPath.get(item.path);
        if (!file) return null;
        // The listing can be stale. Ask the adapter for the current size right
        // before reading, so a file that grew is skipped instead of allocated.
        const current = await adapter.stat?.(file.path).catch(() => null);
        return current?.size ?? file.stat.size;
      },
      read: async (item, capBytes) => {
        const file = byPath.get(item.path);
        if (!file) return { bytes: 0, failed: true };
        // Bounded read: at most capBytes is ever allocated, the handle closes on
        // the cap or the deadline, and a link that leaves the vault is refused.
        // The traversal guard runs on the vault-relative path; the path handed to
        // `fs` is built from the normalized root so it matches that containment
        // check on every platform.
        resolveVaultPath(app, file.path);
        const read = await readBoundedFile(
          nodePath.join(vaultRoot, file.path), vaultRoot, capBytes, deadlineAt
        );
        if (!read.text) return { bytes: 0, tooLarge: read.tooLarge, failed: read.failed, cancelled: read.cancelled };
        const lines = read.text.split("\n").filter(l => l.toLowerCase().includes(q));
        return { bytes: read.bytes, matches: lines.slice(0, 3).map(l => l.trim().slice(0, 500)) };
      },
      onMatch: (item, matches) => {
        if (results.length >= MAX_RESULTS) return false;
        results.push({ path: item.path, matches });
        return results.length < MAX_RESULTS;
      },
    }
  );

  const capped = results.length >= MAX_RESULTS;
  const grewTooLarge = summary.tooLarge;
  const tooLarge = skippedTooLarge + grewTooLarge;
  const partial = capped || summary.deadlineHit || summary.budgetHit ||
    summary.readFailed > 0 || grewTooLarge > 0 || summary.notStarted + summary.deferredByBudget > 0;

  const notes: string[] = [];
  if (capped) notes.push(`Results capped at ${MAX_RESULTS}. Refine your query to see more specific matches.`);
  if (summary.deadlineHit) notes.push("Search stopped at the time budget; results are partial, not empty.");
  if (summary.budgetHit) notes.push(`Search stopped after reserving ${formatMegabytes(MAX_SCAN_TOTAL_BYTES)}; results are partial.`);
  if (tooLarge) notes.push(`${tooLarge} file(s) over ${formatMegabytes(MAX_SCAN_FILE_BYTES)} were not opened${grewTooLarge ? ` (${grewTooLarge} grew after the file listing)` : ""}.`);
  if (summary.readFailed) notes.push(`${summary.readFailed} file(s) could not be read.`);
  const notReached = summary.notStarted + summary.deferredByBudget;
  if (notReached) notes.push(`${notReached} file(s) were not reached.`);

  return {
    results,
    results_shown: results.length,
    capped,
    partial,
    scanned_files: summary.scannedFiles,
    bytes_scanned: summary.bytesScanned,
    skipped: {
      metadata: skippedMetadata,
      too_large: tooLarge,
      binary: skippedBinary,
      read_failed: summary.readFailed,
      not_started: notReached,
    },
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
