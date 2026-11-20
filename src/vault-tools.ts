import { App, TFile } from "obsidian";
import * as nodePath from "node:path";
import { localFileUrl } from "./runtime-files";
import {
  BINARY_EXTS,
  IMAGE_EXTS,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_TOTAL_BYTES,
  MAX_TEXT_BYTES,
  SEARCH_DEADLINE_MS,
  formatMegabytes,
  isIgnoredPath,
  shouldScanContent,
} from "./vault-policy";

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
const MAX_BINARY_BYTES = 32 * 1024 * 1024; // 32 MB

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

function getAbsPath(app: App, file: TFile): string {
  const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
  const base = adapter.basePath ?? adapter.getBasePath?.() ?? "";
  return nodePath.join(base, file.path);
}

/**
 * Resolve the real path & verify it's inside the vault.
 * Prevents symlink-based path traversal (e.g. a symlink pointing to /etc).
 */
function resolveVaultPath(app: App, vaultRelativePath: string): string {
  const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
  const vaultBase = adapter.basePath ?? adapter.getBasePath?.() ?? "";
  const resolved = nodePath.resolve(vaultBase, vaultRelativePath);
  // Ensure the resolved path is still within the vault directory
  if (!resolved.startsWith(vaultBase)) {
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

export async function toolReadFile(app: App, path: string): Promise<ReadFileResult> {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);

  const ext    = file.extension.toLowerCase();
  const bytes  = file.stat.size;
  const sizeMB = (bytes / 1024 / 1024).toFixed(1);

  // ── SVG → text ────────────────────────────────────────────────────────
  if (SVG_EXTS.has(ext)) {
    if (bytes > MAX_TEXT_BYTES)
      throw new Error(
        `SVG is too large to return as text (${sizeMB} MB, limit ${formatMegabytes(MAX_TEXT_BYTES)}). ` +
        "Use run_local_command to inspect it, or read the image it embeds."
      );
    return asText(await app.vault.read(file));
  }

  // ── Raster images — always return as viewable image ───────────────────
  if (IMAGE_EXTS.has(ext)) {
    const mime = mimeType(ext);

    if (bytes > RESIZE_THRESHOLD) {
      const maxDim  = maxDimForSize(bytes);
      const absPath = getAbsPath(app, file);
      try {
        const resized = await resizeImageCanvas(absPath, maxDim);
        const note = `[Auto-resized: original ${sizeMB} MB → ${resized.width}×${resized.height} JPEG 85%]`;
        return { type: "image", mimeType: resized.mimeType, data: resized.data, note };
      } catch (err) {
        throw new Error(
          `Could not process image (${sizeMB} MB): ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
    }

    // Small image — send as-is
    const buf = await app.vault.readBinary(file);
    return { type: "image", mimeType: mime, data: Buffer.from(buf).toString("base64") };
  }

  // ── Known binary — return base64 with metadata ────────────────────────
  if (BINARY_EXTS.has(ext)) {
    if (bytes > MAX_BINARY_BYTES)
      throw new Error(
        `File too large to return as base64 (${sizeMB} MB, limit ${formatMegabytes(MAX_BINARY_BYTES)}). ` +
        "Use run_local_command to inspect it, or fetch it from the server's /raw endpoint."
      );
    const buf = await app.vault.readBinary(file);
    return { type: "binary", mimeType: mimeType(ext), data: Buffer.from(buf).toString("base64"), size: bytes };
  }

  // ── Everything else — text within the limit, base64 above it ──────────
  //
  // Without these checks an unknown extension (`.sql`, `.dump`, a course `.iso`
  // copied into the vault) is decoded as text and can freeze the renderer.
  if (bytes > MAX_TEXT_BYTES) {
    if (bytes > MAX_BINARY_BYTES)
      throw new Error(
        `File too large to read (${sizeMB} MB, base64 limit ${formatMegabytes(MAX_BINARY_BYTES)}). ` +
        "Use run_local_command to inspect it, or fetch it from the server's /raw endpoint."
      );
    const buf = await app.vault.readBinary(file);
    return { type: "binary", mimeType: mimeType(ext), data: Buffer.from(buf).toString("base64"), size: bytes };
  }

  let content: string;
  try {
    content = await app.vault.read(file);
  } catch {
    const buf = await app.vault.readBinary(file);
    return { type: "binary", mimeType: mimeType(ext), data: Buffer.from(buf).toString("base64"), size: bytes };
  }

  // Obsidian reports on-disk bytes; a file whose stat is stale can still decode
  // into something much larger than the scan limit.
  return asText(content);
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
  const approxBytes = Math.ceil(base64Data.length * 3 / 4);
  if (approxBytes > MAX_BINARY_BYTES)
    throw new Error(`Data too large to write (~${(approxBytes / 1024 / 1024).toFixed(1)} MB, max ${MAX_BINARY_BYTES / 1024 / 1024} MB)`);
  const buf = Buffer.from(base64Data, "base64");
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

export async function toolReadFrontmatter(app: App, path: string) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  const content = await app.vault.read(file);
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { path, hasFrontmatter: false, frontmatter: {}, raw: null };
  const raw = fmMatch[1];
  // Parse YAML-like key-value pairs (simple, no full YAML parser dependency)
  const frontmatter: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w[\w\s]*?):\s*(.+)/);
    if (m) frontmatter[m[1].trim()] = m[2].trim();
  }
  return { path, hasFrontmatter: true, frontmatter, raw };
}

export async function toolUpdateFrontmatter(app: App, path: string, updates: Record<string, string | null>) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  let content = await app.vault.read(file);
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
  if (fmMatch) {
    // Parse existing frontmatter into lines
    const fmRaw = fmMatch[0];
    const lines = fmRaw.split("\n");
    const bodyStart = fmRaw.length;
    // Build new frontmatter
    const existing: Record<string, string> = {};
    for (const line of lines) {
      const m = line.match(/^(\w[\w\s]*?):\s*(.+)/);
      if (m) existing[m[1].trim()] = m[2].trim();
    }
    // Apply updates (null = delete key)
    for (const [key, val] of Object.entries(updates)) {
      if (val === null) delete existing[key];
      else existing[key] = val;
    }
    const newFm = "---\n" + Object.entries(existing).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n";
    content = newFm + content.slice(bodyStart).replace(/^---\n[\s\S]*?\n---\n*/, "");
  } else {
    // No frontmatter — create one
    const fmLines = Object.entries(updates)
      .filter(([, val]) => val !== null)
      .map(([k, v]) => `${k}: ${v}`);
    if (fmLines.length > 0) {
      content = "---\n" + fmLines.join("\n") + "\n---\n" + content;
    }
  }
  await app.vault.modify(file, content);
  return { path, action: "frontmatter_updated" };
}

// ── Folder tools ────────────────────────────────────────────────────────────

export async function toolCreateFolder(app: App, path: string) {
  // validatePath already prevents '..' traversal
  try {
    await app.vault.createFolder(path);
    return { path, action: "folder_created" };
  } catch (err) {
    // Folder likely already exists — not an error
    return { path, action: "already_exists" };
  }
}

export async function toolDeleteFolder(app: App, path: string) {
  const folder = app.vault.getAbstractFileByPath(path);
  if (!folder || folder instanceof TFile)
    throw new Error(`Folder not found: ${path}`);
  await app.vault.trash(folder, true);
  return { path, action: "folder_deleted" };
}

export async function toolRenameFolder(app: App, path: string, newPath: string) {
  const folder = app.vault.getAbstractFileByPath(path);
  if (!folder || folder instanceof TFile)
    throw new Error(`Folder not found: ${path}`);
  // Ensure newPath doesn't attempt traversal
  const segments = newPath.split(/[/\\]/);
  if (segments.some(s => s === ".."))
    throw new Error("'newPath' must not traverse outside the vault (no '..')");
  await app.vault.rename(folder, newPath);
  return { path, newPath, action: "folder_renamed" };
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
  const BATCH = 20;
  const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;
  const allFiles = app.vault.getFiles();

  // Filename matches first (no I/O)
  for (const file of allFiles) {
    if (results.length >= MAX_RESULTS) break;
    if (isIgnoredPath(file.path)) continue;
    if (file.path.toLowerCase().includes(q))
      results.push({ path: file.path, matches: ["(filename match)"] });
  }

  // Content search — text-readable files not already matched, in concurrent batches.
  // The size check happens before anything is opened: a single media file read as
  // text used to be enough to freeze the vault.
  const matched = new Set(results.map(r => r.path));
  const textFiles: TFile[] = [];
  let skippedMetadata = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  for (const file of allFiles) {
    if (matched.has(file.path)) continue;
    const decision = shouldScanContent(file.path, file.extension, file.stat.size);
    if (decision.scan) textFiles.push(file);
    else if (decision.reason === "too_large") skippedTooLarge++;
    else if (decision.reason === "binary") skippedBinary++;
    else skippedMetadata++;
  }

  let bytesScanned = 0;
  let filesScanned = 0;
  let readFailures = 0;
  let deadlineHit = false;
  let budgetHit = false;

  interface ScanHit { path: string; matches: string[]; bytes: number; failed: boolean; tooLarge: boolean }

  let cursor = 0;
  while (cursor < textFiles.length && results.length < MAX_RESULTS) {
    if (Date.now() >= deadlineAt) { deadlineHit = true; break; }
    if (bytesScanned >= MAX_SCAN_TOTAL_BYTES) { budgetHit = true; break; }

    // Size the batch from the file list, so one call never reads meaningfully
    // more than the budget instead of overshooting by a whole batch.
    const budgetLeft = MAX_SCAN_TOTAL_BYTES - bytesScanned;
    const batch: TFile[] = [];
    let reserved = 0;
    while (cursor < textFiles.length && batch.length < BATCH) {
      const size = textFiles[cursor].stat.size;
      if (batch.length > 0 && reserved + size > budgetLeft) break;
      reserved += size;
      batch.push(textFiles[cursor]);
      cursor++;
    }

    const batchResults = await Promise.all(
      batch.map(async (file): Promise<ScanHit> => {
        // Checked per file too: a slow batch on a cloud-synced vault must still
        // unwind before the 25 s tool timeout turns the call into an error.
        if (Date.now() >= deadlineAt) return { path: "", matches: [], bytes: 0, failed: false, tooLarge: false };
        try {
          const text  = await app.vault.read(file);
          const bytes = Buffer.byteLength(text);
          // The file may have grown since the file list was taken.
          if (bytes > MAX_TEXT_BYTES) {
            return { path: "", matches: [], bytes: 0, failed: false, tooLarge: true };
          }
          const lines = text.split("\n").filter(l => l.toLowerCase().includes(q));
          const matches = lines.slice(0, 3).map(l => l.trim().slice(0, 500));
          return { path: matches.length ? file.path : "", matches, bytes, failed: false, tooLarge: false };
        } catch {
          return { path: "", matches: [], bytes: 0, failed: true, tooLarge: false };
        }
      })
    );

    for (const r of batchResults) {
      if (r.failed) { readFailures++; continue; }
      if (r.tooLarge) { skippedTooLarge++; continue; }
      filesScanned++;
      bytesScanned += r.bytes;
      if (r.path && results.length < MAX_RESULTS) results.push({ path: r.path, matches: r.matches });
    }
  }

  const capped = results.length >= MAX_RESULTS;
  const partial = capped || deadlineHit || budgetHit || readFailures > 0;
  const notes: string[] = [];
  if (capped) notes.push(`Results capped at ${MAX_RESULTS}. Refine your query to see more specific matches.`);
  if (deadlineHit) notes.push("Search stopped at the time budget; results are partial, not empty.");
  if (budgetHit) notes.push(`Search stopped after reading ${formatMegabytes(MAX_SCAN_TOTAL_BYTES)}; results are partial.`);
  if (skippedTooLarge) notes.push(`${skippedTooLarge} file(s) over ${formatMegabytes(MAX_SCAN_FILE_BYTES)} were not opened.`);
  if (readFailures) notes.push(`${readFailures} file(s) could not be read.`);

  return {
    results,
    results_shown: results.length,
    capped,
    partial,
    scanned_files: filesScanned,
    bytes_scanned: bytesScanned,
    skipped: {
      metadata: skippedMetadata,
      too_large: skippedTooLarge,
      binary: skippedBinary,
      read_failed: readFailures,
    },
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
