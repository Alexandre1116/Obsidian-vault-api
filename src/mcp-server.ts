import { App, TFile } from "obsidian";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import type { Socket } from "node:net";
import * as nodePath from "node:path";
import { exec } from "node:child_process";
import {
  toolListFiles, toolReadFile, toolWriteFile, toolWriteBinary, toolDeleteFile, toolSearch,
  toolReadFrontmatter, toolUpdateFrontmatter,
  toolCreateFolder, toolDeleteFolder, toolRenameFolder, toolAppendFile,
} from "./vault-tools";

// How often to send an SSE keep-alive comment (ms).
const SSE_KEEPALIVE_MS = 15_000;

// Input validation limits
const MAX_PATH_LEN    = 1000;
const MAX_CONTENT_LEN = 50  * 1024 * 1024;  // 50 MB
const MAX_B64_LEN     = 700 * 1024 * 1024;  // ~500 MB binary
const MAX_CMD_LEN     = 2000;
const MAX_QUERY_LEN   = 500;
const MAX_CMD_BUFFER  = 10  * 1024 * 1024;  // 10 MB stdout

// ── Simple glob match for command allowlist ────────────────────────────────
function globMatch(pattern: string, cmd: string): boolean {
  if (pattern === "*") return true;
  // Convert glob to regex: escape dots, replace * with .+, replace ? with .
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    + "$";
  return new RegExp(regexStr, "i").test(cmd.trim());
}

function isCommandAllowed(cmd: string, patterns: string): string | null {
  if (!patterns || patterns === "*") return null; // null = allowed
  const cmds = cmd.trim().split(/\s+/);
  const firstToken = cmds[0] || "";
  for (const pattern of patterns.split(",")) {
    const p = pattern.trim();
    if (!p) continue;
    if (globMatch(p, cmd.trim()) || globMatch(p, firstToken)) return null;
  }
  return `Command '${firstToken}' is not in the allowed list. Allowed patterns: ${patterns}`;
}

function validatePath(p: unknown): string {
  if (typeof p !== "string" || p.length === 0)
    throw new Error("'path' must be a non-empty string");
  if (p.length > MAX_PATH_LEN)
    throw new Error(`'path' is too long (max ${MAX_PATH_LEN} chars)`);
  if (nodePath.isAbsolute(p))
    throw new Error("'path' must be vault-relative (no leading slash or drive letter)");
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === ".."))
    throw new Error("'path' must not traverse outside the vault (no '..')");
  return p;
}

function formatBytes(n: number): string {
  if (n < 1024)         return `${n} bytes`;
  if (n < 1024 * 1024)  return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function validateStr(val: unknown, name: string, maxLen: number): string {
  if (typeof val !== "string")
    throw new Error(`'${name}' must be a string`);
  if (val.length > maxLen)
    throw new Error(`'${name}' is too long (max ${formatBytes(maxLen)})`);
  return val;
}

export class VaultMcpServer {
  private httpServer: http.Server | null = null;
  private transports = new Map<string, SSEServerTransport>();
  private sockets = new Set<Socket>();

  constructor(
    private app: App,
    private port: number,
    private apiKey: string,
    private allowedCommands: string = "*"
  ) {}

  // ── create a fresh Server instance per SSE connection ────────────────────
  private createMcpInstance(): Server {
    const mcp = new Server(
      { name: "obsidian-vault", version: "1.1.2" },
      { capabilities: { tools: {} } }
    );
    this.registerTools(mcp);
    return mcp;
  }

  // ── tool registration ────────────────────────────────────────────────────
  private registerTools(mcp: Server) {
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_files",
          description: "List files in the Obsidian vault. Optionally filter by folder or extension.",
          inputSchema: {
            type: "object",
            properties: {
              folder:    { type: "string", description: "Sub-folder path (optional)" },
              extension: { type: "string", description: "File extension without dot, e.g. 'md' (optional)" },
              limit:     { type: "number", description: "Max files to return (default 2000, max 5000)" },
            },
          },
        },
        {
          name: "read_frontmatter",
          description: "Read the YAML frontmatter of a markdown file. Returns parsed key-value pairs.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path, e.g. 'Notes/idea.md'" },
            },
            required: ["path"],
          },
        },
        {
          name: "update_frontmatter",
          description: "Update or add YAML frontmatter fields on a file. Pass null as value to delete a field. Creates frontmatter if none exists.",
          inputSchema: {
            type: "object",
            properties: {
              path:    { type: "string", description: "Vault-relative path" },
              updates: {
                type: "object",
                description: "Key-value pairs to set. Use null to delete a key. Example: {\"tags\": \"ai, obsidian\", \"status\": null}",
                additionalProperties: { type: ["string", "null"] },
              },
            },
            required: ["path", "updates"],
          },
        },
        {
          name: "create_folder",
          description: "Create a new folder in the vault. No-op if folder already exists.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Folder path, e.g. 'Projects/NewProject'" },
            },
            required: ["path"],
          },
        },
        {
          name: "delete_folder",
          description: "Delete a folder and move it to the system trash (recoverable).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Folder path to delete" },
            },
            required: ["path"],
          },
        },
        {
          name: "rename_folder",
          description: "Rename or move a folder to a new path.",
          inputSchema: {
            type: "object",
            properties: {
              path:    { type: "string", description: "Current folder path" },
              newPath: { type: "string", description: "New folder path" },
            },
            required: ["path", "newPath"],
          },
        },
        {
          name: "append_file",
          description: "Append text content to the end of an existing file.",
          inputSchema: {
            type: "object",
            properties: {
              path:    { type: "string", description: "Vault-relative path" },
              content: { type: "string", description: "Text to append" },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "read_file",
          description:
            "Read any file from the vault. " +
            "Text files (.md, .txt) return their text content. " +
            "Images return the actual image so you can SEE it visually (large images are auto-resized). " +
            "Binary files return base64-encoded data. " +
            "CRITICAL: If you need to process an image using code inside your isolated cloud sandbox (e.g. to embed it in a Word document via python/nodejs), " +
            "you MUST set the `encoding` parameter to `\"base64\"`. This forces the tool to return the raw base64 string as text instead of a visual image block, " +
            "allowing you to embed the base64 string directly into your sandbox script.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path, e.g. 'Notes/idea.md' or 'assets/photo.png'" },
              encoding: { type: "string", description: "Optional. Set to 'base64' to force returning raw base64 text instead of an image block (works for images and binary files)." }
            },
            required: ["path"],
          },
        },
        {
          name: "write_file",
          description: "Create or overwrite a text file in the vault.",
          inputSchema: {
            type: "object",
            properties: {
              path:    { type: "string", description: "Vault-relative path" },
              content: { type: "string", description: "File content (text)" },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "write_binary",
          description:
            "Create or overwrite a binary file in the vault from base64-encoded data. " +
            "Use this to write images, Word documents (.docx), PDFs, or any binary file. " +
            "For example, you can read an image with read_file and then use its data " +
            "to compose a new document.",
          inputSchema: {
            type: "object",
            properties: {
              path:       { type: "string", description: "Vault-relative path, e.g. 'output/report.docx'" },
              base64Data: { type: "string", description: "Base64-encoded file content" },
            },
            required: ["path", "base64Data"],
          },
        },
        {
          name: "delete_file",
          description: "Delete a file from the vault.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "run_local_command",
          description: "Run a shell/terminal command directly on the user's local machine inside the vault directory. This bypasses the cloud sandbox entirely. Use this to run local scripts (Node.js/Python) that process vault files directly, install npm packages, or do anything requiring direct local file system access. This is the ONLY way to access images and binary files directly from code.",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string", description: "The terminal command to execute (e.g. 'node my_script.js')" } },
            required: ["command"],
          },
        },
        {
          name: "search",
          description: "Search vault files by keyword (filename + text content). Searches all text-readable files, not just markdown.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    }));

    // Safety net: 25 s timeout per tool call with cancellation
    const withTimeout = <T>(ms: number, promise: Promise<T>): Promise<T> => {
      const controller = new AbortController();
      const timedOut  = new Promise<T>((_, reject) => {
        const timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Tool timed out after ${ms / 1000} s`));
        }, ms);
        // Clean up timer if the main promise wins the race
        promise.finally(() => clearTimeout(timer));
      });
      return Promise.race([promise, timedOut]);
    };

    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = (args ?? {}) as Record<string, unknown>;

      console.log(`[vault-api] tool: ${name}`);

      try {
        return await withTimeout(25_000, (async () => { switch (name) {
          case "list_files": {
            const folder    = typeof a.folder    === "string" ? a.folder    : undefined;
            const extension = typeof a.extension === "string" ? a.extension : undefined;
            const limit     = typeof a.limit === "number" && a.limit > 0 ? Math.min(a.limit, 5000) : 2000;
            const result = await toolListFiles(this.app, folder, extension, limit);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }

          case "read_file": {
            const p = validatePath(a.path);
            const result = await toolReadFile(this.app, p);
            if (result.type === "image") {
              if (a.encoding === "base64") {
                return { content: [{ type: "text", text: result.data }] };
              }

              const filename = p.split("/").pop() ?? p;
              const fileUrl = `http://127.0.0.1:${this.port}/raw?path=${encodeURIComponent(p)}&key=${this.apiKey}`;

              const meta: string[] = [
                `path: ${p}`,
                `filename: ${filename}`,
                `mimeType: ${result.mimeType}`,
                `obsidian_embed: ![[${filename}]]`,
                `markdown_embed: ![${filename}](${p})`,
                `absolute_disk_path: (depends on vault location, ask user if needed)`,
                `local_http_url: ${fileUrl}`,
                `tip: To use this image's bytes in your execution sandbox/script, you can fetch it from the local_http_url above. Example: await fetch("${fileUrl}")`,
              ];
              if (result.note) meta.push(result.note);

              return {
                content: [
                  { type: "image", data: result.data, mimeType: result.mimeType },
                  { type: "text",  text: meta.join("\n") },
                ],
              };
            }
            if (result.type === "binary") {
              const filename = p.split("/").pop() ?? p;
              const MB = (result.size / 1024 / 1024).toFixed(1);
              if (a.encoding === "base64" || result.size <= 5 * 1024 * 1024) {
                return { content: [{ type: "text", text:
                  `[Binary: ${filename} | ${result.mimeType} | ${MB} MB]\n${result.data}`
                }] };
              }
              return { content: [{ type: "text", text:
                `[Binary file]\npath: ${p}\nfilename: ${filename}\nmimeType: ${result.mimeType}\n` +
                `size: ${result.size} bytes (${MB} MB)\n` +
                `Set encoding: "base64" to retrieve the content, or use run_local_command for large files.`
              }] };
            }
            return { content: [{ type: "text", text: result.content }] };
          }

          case "write_file": {
            const p       = validatePath(a.path);
            const content = validateStr(a.content, "content", MAX_CONTENT_LEN);
            const r = await toolWriteFile(this.app, p, content);
            return { content: [{ type: "text", text: `File ${r.action}: ${r.path}` }] };
          }

          case "write_binary": {
            const p          = validatePath(a.path);
            const base64Data = validateStr(a.base64Data, "base64Data", MAX_B64_LEN);
            const r = await toolWriteBinary(this.app, p, base64Data);
            return { content: [{ type: "text", text: `Binary file ${r.action}: ${r.path} (${r.size} bytes)` }] };
          }

          case "read_frontmatter": {
            const p = validatePath(a.path);
            const result = await toolReadFrontmatter(this.app, p);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }

          case "update_frontmatter": {
            const p = validatePath(a.path);
            const updates = a.updates as Record<string, string | null>;
            if (!updates || typeof updates !== "object")
              throw new Error("'updates' must be an object with key-value pairs");
            const result = await toolUpdateFrontmatter(this.app, p, updates);
            return { content: [{ type: "text", text: `Frontmatter updated on: ${result.path}` }] };
          }

          case "create_folder": {
            const p = validatePath(a.path);
            const result = await toolCreateFolder(this.app, p);
            return { content: [{ type: "text", text: `${result.action}: ${result.path}` }] };
          }

          case "delete_folder": {
            const p = validatePath(a.path);
            const result = await toolDeleteFolder(this.app, p);
            return { content: [{ type: "text", text: `Folder ${result.action}: ${result.path}` }] };
          }

          case "rename_folder": {
            const p       = validatePath(a.path);
            const newPath = validatePath(a.newPath as string);
            const result = await toolRenameFolder(this.app, p, newPath);
            return { content: [{ type: "text", text: `Folder renamed: ${result.path} → ${result.newPath}` }] };
          }

          case "append_file": {
            const p       = validatePath(a.path);
            const content = validateStr(a.content, "content", MAX_CONTENT_LEN);
            const result  = await toolAppendFile(this.app, p, content);
            return { content: [{ type: "text", text: `Appended ${content.length} chars to ${result.path} (total ~${result.totalSize})` }] };
          }

          case "delete_file": {
            const p = validatePath(a.path);
            await toolDeleteFile(this.app, p);
            return { content: [{ type: "text", text: `Deleted: ${p}` }] };
          }

          case "run_local_command": {
            const cmd = validateStr(a.command, "command", MAX_CMD_LEN);

            // Check command allowlist
            const blockReason = isCommandAllowed(cmd, this.allowedCommands);
            if (blockReason) {
              return { content: [{ type: "text", text: `Blocked: ${blockReason}` }], isError: true };
            }

            const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
            const vaultBase = adapter.basePath ?? adapter.getBasePath?.() ?? "";

            console.log(`[vault-api] run_local_command: ${cmd.slice(0, 200)}`);

            return new Promise((resolve) => {
              exec(cmd, { cwd: vaultBase, maxBuffer: MAX_CMD_BUFFER, timeout: 25_000 }, (error, stdout, stderr) => {
                let text = "";
                if (stdout) text += `--- STDOUT ---\n${stdout}\n`;
                if (stderr) text += `--- STDERR ---\n${stderr}\n`;
                if (error)  text += `--- ERROR ---\n${error.message}\n`;

                if (!text) text = "Command executed successfully with no output.";
                resolve({ content: [{ type: "text", text }] });
              });
            });
          }

          case "search": {
            const query   = validateStr(a.query, "query", MAX_QUERY_LEN);
            const results = await toolSearch(this.app, query);
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        } })());
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    });
  }

  // ── HTTP / SSE server ────────────────────────────────────────────────────
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error("[vault-api] unhandled:", err);
          if (!res.headersSent) { res.writeHead(500); res.end("Internal error"); }
        });
      });

      // Disable all timeouts — large images can take a while
      this.httpServer.timeout        = 0;
      this.httpServer.headersTimeout = 0;
      this.httpServer.requestTimeout = 0;

      this.httpServer.on("connection", socket => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });

      this.httpServer.on("error", reject);
      this.httpServer.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.httpServer) return resolve();
      this.transports.clear();
      const server = this.httpServer;
      this.httpServer = null;
      const timeout = setTimeout(() => {
        console.warn("[vault-api] server close timed out, forcing shutdown");
        resolve();
      }, 5000);
      server.close(() => { clearTimeout(timeout); resolve(); });
      // SSE connections are long-lived by design and never end on their own,
      // so Node's close() would otherwise wait for them until the timeout
      // above fires on every restart/reload. Destroying the sockets directly
      // makes close() resolve immediately instead.
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  private authed(req: http.IncomingMessage): boolean {
    if (!this.apiKey) return true;
    const header = req.headers["x-api-key"];
    if (header === this.apiKey) return true;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    return url.searchParams.get("key") === this.apiKey;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    // ── /health — basic info public; vault details require auth ─────────
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const body: Record<string, unknown> = { status: "ok", version: "1.1.2" };
      if (this.authed(req)) {
        body.vault    = this.app.vault.getName();
        body.port     = this.port;
        body.sessions = this.transports.size;
      }
      res.end(JSON.stringify(body));
      return;
    }

    // All other routes require auth
    if (!this.authed(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — send X-Api-Key header or ?key=..." }));
      return;
    }

    // ── /raw — Serve raw file bytes for execution sandboxes ───────────────
    if (url.pathname === "/raw" && req.method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) { res.writeHead(400); res.end("Missing path parameter"); return; }

      try { validatePath(filePath); } catch (e) {
        res.writeHead(400); res.end(`Invalid path: ${e instanceof Error ? e.message : String(e)}`); return;
      }

      try {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !("extension" in file)) {
          res.writeHead(404); res.end("File not found"); return;
        }
        const buf = await this.app.vault.readBinary(file as TFile);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": buf.byteLength
        });
        res.end(Buffer.from(buf));
      } catch (err) {
        console.error("[vault-api] /raw error:", err);
        res.writeHead(500); res.end("Error reading file");
      }
      return;
    }

    // ── SSE connection ──────────────────────────────────────────────────
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/message", res);
      this.transports.set(transport.sessionId, transport);

      // Keep-alive pings to prevent proxy/client timeouts
      const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          try { res.write(": ping\n\n"); } catch { /* stream gone */ }
        }
      }, SSE_KEEPALIVE_MS);

      res.on("close", () => {
        clearInterval(keepAlive);
        this.transports.delete(transport.sessionId);
      });

      const mcpInstance = this.createMcpInstance();
      await mcpInstance.connect(transport);
      return;
    }

    // ── MCP message endpoint ────────────────────────────────────────────
    if (url.pathname === "/message" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = this.transports.get(sessionId);
      if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404); res.end("Not found");
  }
}
