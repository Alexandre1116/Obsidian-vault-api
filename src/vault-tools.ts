import { App, TFile } from "obsidian";
import * as nodePath from "node:path";

// ── extension sets ────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp","tiff","tif"]);
const SVG_EXTS   = new Set(["svg"]);
const TEXT_EXTS  = new Set(["md","txt","json","yaml","yml","toml","csv","html","css","js","ts","xml","canvas"]);

// Images larger than this are auto-resized (bytes)
const RESIZE_THRESHOLD = 4 * 1024 * 1024; // 4 MB
// Maximum dimension (width or height) after resize
const MAX_DIM = 2048;

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

/** Returns the absolute filesystem path for a vault file. */
function getAbsPath(app: App, file: TFile): string {
  // TypeScript doesn't expose basePath, but it exists on the desktop adapter.
  const adapter = app.vault.adapter as { basePath?: string; getBasePath?: () => string };
  const base = adapter.basePath ?? adapter.getBasePath?.() ?? "";
  return nodePath.join(base, file.path);
}

/**
 * Convert an absolute filesystem path to a file:// URL safe for use as
 * img.src inside Electron (handles Windows back-slashes and spaces).
 */
function toFileUrl(absPath: string): string {
  // Windows: C:\Users\foo\bar.jpg  →  file:///C:/Users/foo/bar.jpg
  const forward = absPath.replace(/\\/g, "/");
  // Encode only the parts that need it (spaces, non-ASCII) but leave : / intact
  const encoded = forward.split("/").map((seg, i) =>
    // Skip the leading empty string and the drive letter segment (e.g. "C:")
    i === 0 || (i === 1 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg)
  ).join("/");
  return "file:///" + encoded;
}

/**
 * Resize an image to at most MAX_DIM × MAX_DIM using the Electron/Chromium
 * Canvas API.  Loads directly from disk via file:// — no readBinary, so even
 * 1 GB+ files are handled without exhausting the Node.js heap.
 *
 * Exports as JPEG 90% for excellent quality at much smaller size.
 */
function resizeImageCanvas(
  absPath: string,
  maxDim: number
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  const fileUrl = toFileUrl(absPath);

  return new Promise((resolve, reject) => {
    const img = new Image();

    // 60-second timeout — large images can take a moment for Chromium to decode
    const timer = setTimeout(() => {
      img.src = "";
      reject(new Error("Image decode timeout (>60 s)"));
    }, 60_000);

    img.onload = () => {
      clearTimeout(timer);
      try {
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        if (w === 0 || h === 0) {
          reject(new Error("Image has zero dimensions — may be unsupported format"));
          return;
        }

        // Downscale preserving aspect ratio
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

        const dataUrl = canvas.toDataURL("image/jpeg", 0.90);
        resolve({
          data:     dataUrl.split(",")[1],
          mimeType: "image/jpeg",
          width:    w,
          height:   h,
        });
      } catch (e) {
        reject(e);
      }
    };

    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Chromium could not decode image: ${absPath}`));
    };

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

  const ext      = file.extension.toLowerCase();
  const sizeMB   = (file.stat.size / 1024 / 1024).toFixed(1);

  // ── SVG → text (it's XML; Claude can read it directly) ───────────────
  if (SVG_EXTS.has(ext)) {
    return { type: "text", content: await app.vault.read(file) };
  }

  // ── Raster images ─────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    const mime = mimeType(ext);

    if (file.stat.size > RESIZE_THRESHOLD) {
      // ── LARGE image: resize via Canvas — no readBinary, heap-safe ──────
      const absPath = getAbsPath(app, file);
      try {
        const resized = await resizeImageCanvas(absPath, MAX_DIM);
        const note = `[Auto-resized: original ${sizeMB} MB → ${resized.width}×${resized.height} JPEG 90 %]`;
        return { type: "image", mimeType: resized.mimeType, data: resized.data, note };
      } catch (err) {
        // Give a clear error instead of a silent hang or OOM crash
        throw new Error(
          `Image too large to send as-is (${sizeMB} MB) and Canvas resize failed: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
    }

    // ── Small image: send as-is ──────────────────────────────────────────
    const buf = await app.vault.readBinary(file);
    return { type: "image", mimeType: mime, data: Buffer.from(buf).toString("base64") };
  }

  // ── Text files ────────────────────────────────────────────────────────
  if (TEXT_EXTS.has(ext)) {
    return { type: "text", content: await app.vault.read(file) };
  }

  // ── Unknown binary ────────────────────────────────────────────────────
  const buf = await app.vault.readBinary(file);
  return {
    type:     "binary",
    mimeType: mimeType(ext),
    data:     Buffer.from(buf).toString("base64"),
  };
}

export async function toolWriteFile(app: App, path: string, content: string) {
  const existing = getFile(app, path);
  if (existing) {
    await app.vault.modify(existing, content);
    return { path, action: "updated" };
  }
  // Ensure parent folders exist
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
