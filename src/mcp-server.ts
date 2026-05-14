import { App } from "obsidian";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import { toolListFiles, toolReadFile, toolWriteFile, toolDeleteFile, toolSearch } from "./vault-tools";

export class VaultMcpServer {
  private httpServer: http.Server | null = null;
  private transports = new Map<string, SSEServerTransport>();

  constructor(private app: App, private port: number, private apiKey: string) {}

  // ── create a fresh Server instance per SSE connection ────────────────────
  // The MCP SDK Server only supports one active transport at a time, so we
  // must create a new instance for every incoming SSE connection.
  private createMcpInstance(): Server {
    const mcp = new Server(
      { name: "obsidian-vault", version: "1.0.1" },
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
            "Read a vault file. Returns text content for .md/.txt/etc, or an inline image for " +
            ".png/.jpg/.webp/etc so you can see the image directly. " +
            "Large images (>4 MB) are automatically resized to max 2048 px JPEG — no size limit.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path, e.g. 'Photos/photo.jpg'" },
            },
            required: ["path"],
          },
        },
        {
          name: "write_file",
          description: "Create or overwrite a file in the vault.",
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
          name: "delete_file",
          description: "Delete a file from the vault.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "search",
          description: "Search vault notes by keyword (filename + content).",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = (args ?? {}) as Record<string, string>;

      try {
        switch (name) {
          case "list_files": {
            const files = await toolListFiles(this.app, a.folder, a.extension);
            return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
          }

          case "read_file": {
            const result = await toolReadFile(this.app, a.path);
            if (result.type === "image") {
              // Return the image + optional resize note as separate content blocks
              const content: { type: string; data?: string; mimeType?: string; text?: string }[] = [
                { type: "image", data: result.data, mimeType: result.mimeType },
              ];
              if (result.note) {
                content.push({ type: "text", text: result.note });
              }
              return { content };
            }
            return { content: [{ type: "text", text: (result as { content: string }).content }] };
          }

          case "write_file": {
            const r = await toolWriteFile(this.app, a.path, a.content);
            return { content: [{ type: "text", text: `File ${r.action}: ${r.path}` }] };
          }

          case "delete_file": {
            await toolDeleteFile(this.app, a.path);
            return { content: [{ type: "text", text: `Deleted: ${a.path}` }] };
          }

          case "search": {
            const results = await toolSearch(this.app, a.query);
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
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

      // Disable all timeouts so large image resizing never kills the connection
      this.httpServer.timeout        = 0;   // no socket idle timeout
      this.httpServer.headersTimeout = 0;   // no headers timeout
      this.httpServer.requestTimeout = 0;   // no request timeout (Node 18+)

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

    if (!this.authed(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — send X-Api-Key header or ?key=..." }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    // SSE connection endpoint — new Server instance per connection
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/message", res);
      this.transports.set(transport.sessionId, transport);
      res.on("close", () => this.transports.delete(transport.sessionId));
      const mcpInstance = this.createMcpInstance();
      await mcpInstance.connect(transport);
      return;
    }

    // MCP message endpoint
    if (url.pathname === "/message" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = this.transports.get(sessionId);
      if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
      await transport.handlePostMessage(req, res);
      return;
    }

    // Health check
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status:   "ok",
        version:  "0.1.1",
        vault:    this.app.vault.getName(),
        port:     this.port,
        sessions: this.transports.size,
      }));
      return;
    }

    res.writeHead(404); res.end("Not found");
  }
}
