import { App } from "obsidian";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import { exec } from "node:child_process";
import { toolListFiles, toolReadFile, toolWriteFile, toolWriteBinary, toolDeleteFile, toolSearch } from "./vault-tools";

// How often to send an SSE keep-alive comment (ms).
const SSE_KEEPALIVE_MS = 15_000;

export class VaultMcpServer {
  private httpServer: http.Server | null = null;
  private transports = new Map<string, SSEServerTransport>();

  constructor(private app: App, private port: number, private apiKey: string) {}

  // ── create a fresh Server instance per SSE connection ────────────────────
  private createMcpInstance(): Server {
    const mcp = new Server(
      { name: "obsidian-vault", version: "0.2.0" },
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
            },
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
              encoding: { type: "string", description: "Optional. Set to 'base64' to force returning raw base64 text instead of an image block." }
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

    // Safety net: 25 s timeout per tool call
    const withTimeout = <T>(ms: number, promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool timed out after ${ms / 1000} s`)), ms)
        ),
      ]);

    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = (args ?? {}) as Record<string, string>;

      try {
        return await withTimeout(25_000, (async () => { switch (name) {
          case "list_files": {
            const files = await toolListFiles(this.app, a.folder, a.extension);
            return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
          }

          case "read_file": {
            const result = await toolReadFile(this.app, a.path);
            if (result.type === "image") {
              if (a.encoding === "base64") {
                return { content: [{ type: "text", text: result.data }] };
              }

              const filename = a.path.split("/").pop() ?? a.path;
              const absPath = this.app.vault.adapter.getResourcePath(a.path);
              const fileUrl = `http://127.0.0.1:${this.port}/raw?path=${encodeURIComponent(a.path)}&key=${this.apiKey}`;
              
              const meta: string[] = [
                `path: ${a.path}`,
                `filename: ${filename}`,
                `mimeType: ${result.mimeType}`,
                `obsidian_embed: ![[${filename}]]`,
                `markdown_embed: ![${filename}](${a.path})`,
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
              const filename = a.path.split("/").pop() ?? a.path;
              return { content: [{ type: "text", text:
                `[Binary file]\n` +
                `path: ${a.path}\n` +
                `filename: ${filename}\n` +
                `mimeType: ${result.mimeType}\n` +
                `size: ${result.size} bytes (${(result.size / 1024 / 1024).toFixed(1)} MB)\n` +
                `base64_length: ${result.data.length}\n` +
                `tip: This is base64-encoded binary data. You can use write_binary to save modified versions.`
              }] };
            }
            return { content: [{ type: "text", text: result.content }] };
          }

          case "write_file": {
            const r = await toolWriteFile(this.app, a.path, a.content);
            return { content: [{ type: "text", text: `File ${r.action}: ${r.path}` }] };
          }

          case "write_binary": {
            const r = await toolWriteBinary(this.app, a.path, a.base64Data);
            return { content: [{ type: "text", text: `Binary file ${r.action}: ${r.path} (${r.size} bytes)` }] };
          }

          case "delete_file": {
            await toolDeleteFile(this.app, a.path);
            return { content: [{ type: "text", text: `Deleted: ${a.path}` }] };
          }

          case "run_local_command": {
            const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
            const vaultBase = adapter.basePath ?? adapter.getBasePath?.() ?? "";
            
            return new Promise((resolve) => {
              exec(a.command, { cwd: vaultBase, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
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
            const results = await toolSearch(this.app, a.query);
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

      this.httpServer.on("error", reject);
      this.httpServer.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.httpServer) return resolve();
      this.transports.clear();
      this.httpServer.close(() => resolve());
      this.httpServer = null;
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

    // ── /health — public, no auth needed ────────────────────────────────
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status:   "ok",
        version:  "0.2.0",
        vault:    this.app.vault.getName(),
        port:     this.port,
        sessions: this.transports.size,
      }));
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
      if (!filePath) {
        res.writeHead(400); res.end("Missing path parameter"); return;
      }
      try {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !("extension" in file)) {
          res.writeHead(404); res.end("File not found"); return;
        }
        const buf = await this.app.vault.readBinary(file as any);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": buf.byteLength
        });
        res.end(Buffer.from(buf));
      } catch (err) {
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
