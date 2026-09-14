import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type FileSyncStatus = "created" | "updated" | "unchanged";

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function ensureFileContent(filePath: string, content: string): FileSyncStatus {
  let exists = true;
  try {
    if (fs.readFileSync(filePath, "utf-8") === content) return "unchanged";
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    exists = false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return exists ? "updated" : "created";
}

export function localFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
