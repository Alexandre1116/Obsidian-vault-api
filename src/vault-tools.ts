import { App, TFile } from "obsidian";
import * as nodePath from "node:path";

// ── extension sets ────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp","tiff","tif"]);
const SVG_EXTS   = new Set(["svg"]);
const TEXT_EXTS  = new Set(["md","txt","json","yaml","yml","toml","csv","html","css","js","ts","xml","canvas"]);

// Threshold below which images are sent as-is (bytes)
const RESIZE_THRESHOLD = 4 * 1024 * 1024; // 4 MB

// Tiered max-dimension based on file size — smaller canvas = faster decode
// Canvas timeout must complete well within mcp-remote's ~30 s call timeout.
function maxDimForSize(bytes: number): number {
  if (bytes > 100 * 1024 * 1024) return 512;   // > 100 MB → 512 px
  if (bytes >  20 * 1024 * 1024) return 800;   // >  20 MB → 800 px
  return 1024;                                  // default  → 1024 px
}

// Hard timeout for the Canvas decode + resize step (ms).
// Must be shorter than the mcp-remote tool-call timeout (~30 s).
const CANVAS_TIMEOUT_MS = 15_000;

// ── mime ──────────────────────────────────────────────────────────────────
function mimeType(ext: string): string {
  const t: Record<string, string> = {
    png:  "image/png",    jpg:  "image/jpeg",  jpeg: "image/jpeg",
    gif:  "image/gif",    webp: "image/webp",  svg:  "image/svg+xml",
    bmp:  "image/bmp",    tiff: "image/tiff",  tif:  "image/tiff",
    pdf:  "application/pdf",
  };
  return t[ext.toLowerCase()] ?? "application/octet-stream";
}

// ── helpers ───────────────────────────────────────────────────────────────
function getFile(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

function getAbsPath(app: App, file: TFile): string {
  const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
  const base = adapter.basePath ?? adapter.getBasePath?.() ?? "";
  return nodePath.join(base, file.path);
}

function toFileUrl(absPath: string): string {
  const forward = absPath.replace(/\\/g, "/");
  const encoded = forward.split("/").map((seg, i) =>
    i === 0 || (i === 1 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg)
  ).join("/");
  return "file:///" + encoded;
}

/**
 * Resize via Electron/Chromium Canvas API.
 * - maxDim is chosen per file size (smaller file → more pixels are OK)
 * - Hard timeout: if Chromium hasn't decoded the image in CANVAS_TIMEOUT_MS,
 *   we reject immediately so the MCP call returns an error before the client
 *   times out and drops the SSE connection.
 */
function resizeImageCanvas(
  absPath: string,
  maxDim: number
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  const fileUrl = toFileUrl(absPath);

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
        img.src = "";  // try to abort in-flight decode
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

export async function toolListFiles(app: App, folder = "", extension = "") {
  let files = app.vault.getFiles();
  if (folder)
    files = files.filter(f =>
      f.path.startsWith(folder.replace(/\/$/, "") + "/") || f.path === folder
    );
  if (extension) {
    const ext = extension.replace(/^\./, "").toLowerCase();
    files = files.filter(f => f.extension.toLowerCase() === ext);
  }
  return files.map(f => ({
    path:      f.path,
    name:      f.name,
    extension: f.extension,
    size:      f.stat.size,
    modified:  new Date(f.stat.mtime).toISOString(),
  }));
}

export type ReadFileResult =
  | { type: "text";   content: string }
  | { type: "image";  mimeType: string; data: string; note?: string }
  | { type: "binary"; mimeType: string; data: string };

export async function toolReadFile(app: App, path: string): Promise<ReadFileResult> {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);

  const ext    = file.extension.toLowerCase();
  const bytes  = file.stat.size;
  const sizeMB = (bytes / 1024 / 1024).toFixed(1);

  // ── SVG → text ────────────────────────────────────────────────────────
  if (SVG_EXTS.has(ext)) {
    return { type: "text", content: await app.vault.read(file) };
  }

  // ── Raster images ─────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    const mime = mimeType(ext);

    if (bytes > RESIZE_THRESHOLD) {
      const maxDim  = maxDimForSize(bytes);
      const absPath = getAbsPath(app, file);
      try {
        const resized = await resizeImageCanvas(absPath, maxDim);
        const note = `[Auto-resized: original ${sizeMB} MB → ${resized.width}×${resized.height} JPEG 85 %]`;
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

  // ── Text files ────────────────────────────────────────────────────────
  if (TEXT_EXTS.has(ext)) {
    return { type: "text", content: await app.vault.read(file) };
  }

  // ── Unknown binary ────────────────────────────────────────────────────
  const buf = await app.vault.readBinary(file);
  return { type: "binary", mimeType: mimeType(ext), data: Buffer.from(buf).toString("base64") };
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

export async function toolDeleteFile(app: App, path: string) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);
  await app.vault.delete(file);
  return { path, action: "deleted" };
}

export async function toolSearch(app: App, query: string) {
  const q = query.toLowerCase();
  const results: { path: string; matches: string[] }[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (results.length >= 40) break;
    const inName = file.path.toLowerCase().includes(q);
    if (inName) {
      results.push({ path: file.path, matches: ["(filename match)"] });
      continue;
    }
    try {
      const text  = await app.vault.read(file);
      const lines = text.split("\n").filter(l => l.toLowerCase().includes(q));
      if (lines.length)
        results.push({ path: file.path, matches: lines.slice(0, 3).map(l => l.trim()) });
    } catch { /* skip unreadable */ }
  }
  return results;
}
