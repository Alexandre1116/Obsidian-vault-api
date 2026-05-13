import { App, TFile } from "obsidian";

// ── mime ──────────────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","svg","bmp","tiff"]);
const TEXT_EXTS  = new Set(["md","txt","json","yaml","yml","toml","csv","html","css","js","ts","xml","canvas"]);

function mimeType(ext: string): string {
  const t: Record<string,string> = {
    png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg",
    gif:"image/gif", webp:"image/webp", svg:"image/svg+xml",
    bmp:"image/bmp", tiff:"image/tiff", pdf:"application/pdf",
  };
  return t[ext.toLowerCase()] ?? "application/octet-stream";
}

// ── helpers ───────────────────────────────────────────────────────────────
function getFile(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

// ── tool implementations ──────────────────────────────────────────────────

export async function toolListFiles(app: App, folder = "", extension = "") {
  let files = app.vault.getFiles();
  if (folder)    files = files.filter(f => f.path.startsWith(folder.replace(/\/$/, "") + "/") || f.path === folder);
  if (extension) {
    const ext = extension.replace(/^\./, "").toLowerCase();
    files = files.filter(f => f.extension.toLowerCase() === ext);
  }
  return files.map(f => ({
    path: f.path, name: f.name,
    extension: f.extension,
    size: f.stat.size,
    modified: new Date(f.stat.mtime).toISOString(),
  }));
}

export async function toolReadFile(app: App, path: string) {
  const file = getFile(app, path);
  if (!file) throw new Error(`File not found: ${path}`);

  if (IMAGE_EXTS.has(file.extension.toLowerCase())) {
    const buf = await app.vault.readBinary(file);
    return {
      type: "image" as const,
      mimeType: mimeType(file.extension),
      data: Buffer.from(buf).toString("base64"),
    };
  }

  if (TEXT_EXTS.has(file.extension.toLowerCase())) {
    return { type: "text" as const, content: await app.vault.read(file) };
  }

  // unknown binary — return base64
  const buf = await app.vault.readBinary(file);
  return {
    type: "binary" as const,
    mimeType: mimeType(file.extension),
    data: Buffer.from(buf).toString("base64"),
  };
}

export async function toolWriteFile(app: App, path: string, content: string) {
  const existing = getFile(app, path);
  if (existing) {
    await app.vault.modify(existing, content);
    return { path, action: "updated" };
  }
  // ensure parent folders
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
      const text = await app.vault.read(file);
      const lines = text.split("\n").filter(l => l.toLowerCase().includes(q));
      if (lines.length) results.push({ path: file.path, matches: lines.slice(0, 3).map(l => l.trim()) });
    } catch { /* skip */ }
  }
  return results;
}