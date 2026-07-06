# Vault API — Obsidian MCP Plugin

Obsidian desktop plugin that turns any vault into a local MCP server (SSE transport on `127.0.0.1:<port>`), so MCP-compatible AI clients (Claude Desktop, LM Studio, Ollama, Open WebUI) can read/write/search files, view images, and run shell commands inside the vault. The plugin *is* the server — no external process to manage.

## Stack
- TypeScript, bundled with esbuild (`esbuild.config.mjs`) into a single CommonJS `main.js`
- `@modelcontextprotocol/sdk` for the MCP `Server` + `SSEServerTransport`
- Obsidian plugin API (`obsidian` package — types only, the real implementation is injected by the host app at runtime)
- vitest for unit tests

## Layout
- `src/main.ts` — plugin lifecycle (`onload`/`onunload`), settings tab UI, Claude Desktop auto-config (writes `claude_desktop_config.json`), bridge-file management
- `src/mcp-server.ts` — HTTP+SSE server: auth, input validation (`validatePath`, `validateStr`, size limits), tool registration/dispatch (`ListToolsRequestSchema` / `CallToolRequestSchema`), `/health` and `/raw` routes
- `src/vault-tools.ts` — the actual file operations (read/write/append/delete, frontmatter, folders, search), symlink-traversal defense, tiered image resizing, MIME table
- `bridge.js` (repo root) — stdio↔SSE bridge that Claude Desktop spawns via `node bridge.js <port>`; this is the **source of truth**
- `src/bridge-source.ts` — **generated file, never edit by hand** (see below)
- `scripts/sync-bridge.mjs` — embeds `bridge.js` as a string constant into `src/bridge-source.ts`
- `tests/vault-tools.test.ts` — unit tests for the pure-logic helpers (extension sets, MIME lookup, resize-tier math)

## Commands
- `npm run dev` — sync bridge + esbuild watch build
- `npm run build` — sync bridge + production build → `main.js`
- `npm run typecheck` — sync bridge + `tsc --noEmit`
- `npm run test` / `npm run test:watch` — sync bridge + vitest

All four scripts run `sync-bridge` first. **Never invoke `tsc`, `vitest`, or `esbuild` directly** — if you skip the sync step, `src/bridge-source.ts` goes stale against `bridge.js` and the embedded bridge silently reverts to whatever was last synced.

## Editing `bridge.js`
If `bridge.js` at the repo root changes, `main.js` won't reflect it until a build regenerates `src/bridge-source.ts`. At runtime, `main.ts` writes that embedded string to `os.tmpdir()/obsidian-vault-api-bridge/bridge.js` — never to the vault's plugin folder (see `getBridgeDir()` in `main.ts` for the cloud-sync reasoning behind that).

## Security model — don't weaken without discussion
- Every vault path goes through `validatePath()`: must be relative, no `..` segments, no absolute paths or drive letters.
- `run_local_command` is gated by a comma-separated glob allowlist (the `allowedCommands` setting, default `*`); the child process runs with a 25s timeout and a 10 MB stdout cap, cwd'd to the vault's base path.
- Every route except `/health`'s public subset requires the API key via `X-Api-Key` header or `?key=` query param.
- `getFile()` / `resolveVaultPath()` in `vault-tools.ts` defend against symlink traversal — any new tool touching the filesystem must go through these, not raw `fs` calls.
- `delete_file` / `delete_folder` move to the system trash; nothing in this plugin hard-deletes.

## Release checklist
Version lives in three places that must stay in sync: `manifest.json`, `package.json`, and `versions.json` (which maps version → `minAppVersion`). Update the README changelog table for every release. License is CC BY-NC-SA 4.0 — non-commercial, attribution required (Alexandre Ramos).

## Gotchas worth knowing before touching this
- `bridge.js` is written to the OS temp dir, not the plugin folder. Vaults are frequently stored inside cloud-sync folders (OneDrive, Synology Drive, Google Drive), and those clients can leave a just-written file un-materialized long enough that Claude Desktop's `node <path>` spawn fails with `MODULE_NOT_FOUND` even though the write reported success. This is what the v1.1.2 hotfix addressed — don't reintroduce a vault-relative bridge path.
- `syncClaudeConfig(onlyIfPresent=true)` runs silently on every plugin load to self-heal an existing `"obsidian"` entry in `claude_desktop_config.json` (fixes stale bridge path or API key). It must never *add* a new entry on its own — only the explicit "Connect Claude" action (`onlyIfPresent=false`) is allowed to do that. Don't change this asymmetry.
- BRAT only fetches `manifest.json` / `main.js` / `styles.css` from a release — anything else needed at runtime (i.e. `bridge.js`) has to be embedded inside `main.js`, not shipped as a sibling file.
- `/health` intentionally leaks nothing sensitive when unauthenticated (`status`, `version` only) — `vault`, `port`, `sessions` require the API key.
