# Vault API project guide

This file is the main working guide for coding agents in this repository. Read it before changing code. More focused instructions live under `.agents/`.

## Project at a glance

Vault API is a desktop-only Obsidian plugin that exposes the current vault as a local Model Context Protocol server. The server runs inside Obsidian and listens on `127.0.0.1`. MCP clients can connect over HTTP and Server-Sent Events, or through the bundled local stdio bridge.

- Current release: `1.3.0`
- Minimum Obsidian version: `1.0.0`
- Default port: `2768`
- License: CC BY-NC-SA 4.0
- Author: Alexandre Ramos

Use the related Docker project for an always-on server or NAS deployment. This repository is for desktop use while Obsidian is running. See `RELATED_PROJECTS.md`.

## Supported clients

The settings page can write MCP configuration for:

- Claude Code CLI and Claude Desktop
- ChatGPT app and Codex CLI
- Google Antigravity CLI and app or IDE
- Generic MCP clients that connect directly to the authenticated SSE endpoint

The configured entry is always named `obsidian`. JSON clients use `mcpServers.obsidian`. Codex uses `[mcp_servers.obsidian]` in TOML.

## Runtime flow

1. Obsidian loads `main.js` and creates `VaultApiPlugin`.
2. The plugin loads settings, generates a 24-byte random API key when one does not exist, and prepares the stdio bridge.
3. With auto-start enabled, `VaultMcpServer` listens on `127.0.0.1:<port>`.
4. Direct clients connect to `/sse` and post MCP messages to the session endpoint.
5. Stdio clients launch `node bridge.js <port>`. The API key is passed through `VAULT_API_KEY`, not through the command line.
6. The bridge converts line-delimited stdio JSON-RPC to local HTTP and SSE traffic.

The public health response only contains `status` and `version`. Authenticated requests may receive vault, port, and session details.

## MCP tools

The server exposes these tools:

| Tool | Operation |
| --- | --- |
| `list_files` | List vault files with optional folder and extension filters. |
| `read_file` | Read text, SVG, image, or binary content. |
| `write_file` | Create or replace a text file. |
| `write_binary` | Create or replace a binary file from base64. |
| `append_file` | Append text to an existing file. |
| `delete_file` | Move a file to the system trash. |
| `read_frontmatter` | Read YAML frontmatter from Markdown. |
| `update_frontmatter` | Add, update, or remove frontmatter fields through `processFrontMatter` (Obsidian 1.4.4+). |
| `create_folder` | Create a vault folder. |
| `delete_folder` | Move a folder to the system trash. |
| `rename_folder` | Rename or move a folder inside the vault. |
| `search` | Search file names and readable file content. |
| `run_local_command` | Run an allowlisted shell command with the vault as cwd. |

Search returns at most 50 results and up to three matching lines per file. It reads text files in batches of 20. Binary reads are limited to 500 MB. Files under 5 MB can be returned as base64. Large images are resized before being returned.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, settings, server control, bridge management, and client config synchronization. |
| `src/mcp-server.ts` | HTTP and SSE transport, authentication, validation, MCP schemas, and dispatch. |
| `src/vault-tools.ts` | Vault file, folder, frontmatter, image, binary, search, and path-resolution operations. |
| `src/client-config.ts` | Non-destructive updates for JSON MCP configs and Codex TOML. |
| `src/runtime-files.ts` | Write-if-changed runtime files and cross-platform local file URLs. |
| `bridge.js` | Source of truth for the local stdio to SSE bridge. |
| `scripts/sync-bridge.mjs` | Generates `src/bridge-source.ts` from `bridge.js`. |
| `tests/` | Vitest tests for pure logic, config updates, and runtime-file handling. |
| `main.js` | Committed production bundle loaded by Obsidian and shipped to BRAT. |
| `manifest.json` | Obsidian plugin identity, version, compatibility, and desktop-only flag. |
| `versions.json` | Version to minimum Obsidian version map. Keep old entries. |
| `docs/RELEASING.md` | Release and BRAT procedure. |
| `.github/workflows/ci.yml` | CI on Ubuntu, Windows, and macOS with Node.js 20. |
| `.github/workflows/release.yml` | Tag-driven build and GitHub Release asset upload. |
| `.agents/` | Shared agent rules, commands, specialist reviews, and project skills. |

`src/bridge-source.ts` is generated and ignored by Git. Never edit it by hand.

## Stack and build output

- TypeScript with strict checking, ES2022 target, and bundler module resolution
- Obsidian API supplied by the desktop host at runtime
- `@modelcontextprotocol/sdk` for MCP and SSE transport
- esbuild for the single CommonJS `main.js` bundle
- Vitest for unit tests
- Node.js 18 or newer for connected stdio clients, Node.js 20 in CI

Obsidian and Electron stay external to the bundle. Production builds omit source maps. Development builds use inline source maps.

## Required commands

Run the repository scripts instead of invoking `tsc`, `vitest`, or `esbuild` directly:

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

Every npm script runs `npm run sync-bridge` first. This keeps `src/bridge-source.ts` synchronized with `bridge.js`. Running the underlying tools directly can test or build stale bridge code.

Use `npm run dev` for an esbuild watch build and `npm run test:watch` for interactive tests.

## Bridge and temporary files

`bridge.js` must be embedded in `main.js` because BRAT downloads only `main.js`, `manifest.json`, and `styles.css`.

At runtime, the plugin writes the embedded bridge to:

```text
<os-temp-directory>/obsidian-vault-api-bridge/bridge.js
```

The path is deliberately outside the vault. Vaults often live in OneDrive, Synology Drive, or another synchronized folder where a new file may remain a placeholder long enough to break client startup.

The bridge path stays stable across sessions because client config files refer to it. `ensureFileContent()` reads the current bridge and writes only when it is missing or changed. Do not delete the shared bridge during plugin unload. Another vault or client may still use it.

Use `pathToFileURL()` through `localFileUrl()` for local file URLs. Do not build `file://` URLs with string replacement. Windows drive letters, spaces, and non-ASCII paths need proper URL encoding.

## Settings and defaults

`src/main.ts` owns these settings:

| Setting | Default | Notes |
| --- | --- | --- |
| Claude target | Desktop | CLI and Desktop paths are stored separately. |
| Codex target | CLI | CLI and app paths are stored separately. |
| Antigravity target | App or IDE | CLI and app paths are stored separately. |
| Port | `2768` | Restart the server after changing it. |
| API key | Generated | Regeneration requires reconnecting configured clients. |
| Auto-start | Enabled | Starts the server when Obsidian loads. |
| Allowed commands | `*` | Comma-separated glob allowlist. |
| Node executable | `node` | An absolute path can be configured for Windows, macOS, or Linux. |

Default client paths:

- Claude CLI: `~/.claude.json`
- Claude Desktop on Windows: `%APPDATA%/Claude/claude_desktop_config.json`
- Claude Desktop on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Desktop on Linux: `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`, falling back to `~/.config/Claude/claude_desktop_config.json`
- Codex CLI and app: `~/.codex/config.toml`
- Antigravity: first existing file among `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity/mcp_config.json`

Legacy single-path settings remain in the schema only so `loadSettings()` can migrate older installations.

## Client config rules

- Preserve unrelated MCP servers and unrelated config fields.
- Return `added`, `updated`, or `unchanged` so the UI can report the real result.
- Put `VAULT_API_KEY` in the child process environment.
- Keep `node` as the default when no custom executable is set.
- Create a missing parent directory before writing a config file.
- Never log or expose the API key.
- On load, Claude config self-healing may update an existing `obsidian` entry. It must not add one. Only the explicit Connect action may add the entry.

## Security invariants

This plugin grants local file and command access. Treat changes at the filesystem, command, and HTTP boundaries as security-sensitive.

- Validate every caller-provided vault path. Reject absolute paths, drive letters, null bytes, and `..` traversal.
- Route file access through `getFile()` or `resolveVaultPath()` so symlinks cannot escape the vault.
- Authenticate every route except the limited public `/health` response.
- Keep limits for paths, content, base64 input, command length, query length, process output, and image operations.
- Check `run_local_command` against the configured allowlist. A restricted allowlist rejects shell operators such as `;`, `&`, `|`, backticks, `$`, `<`, `>`, and newlines. Review this handling whenever the code changes.
- Keep command execution bounded by a 25-second timeout and a 10 MB output buffer.
- Use Obsidian's system-trash operation for file and folder deletion. Do not add permanent deletion.
- Never put the API key in logs, error messages, tool results, request URLs built by the plugin or bridge, or process arguments. Client configs must pass it through `VAULT_API_KEY`. The settings UI may show the authenticated local MCP URL for manual client setup.

Run the specialist review in `.agents/agents/vault-security-reviewer.md` after changing `src/main.ts`, `src/mcp-server.ts`, or `src/vault-tools.ts` in a way that touches these boundaries.

## Testing rules

`obsidian` is a types-only dependency in this repository. Its runtime implementation exists only inside Obsidian. Tests must not import modules that require the live Obsidian runtime unless a deliberate mock or integration harness is added.

`tests/vault-tools.test.ts` duplicates pure helpers from `src/vault-tools.ts` and `src/mcp-server.ts`. When changing duplicated logic, update the test copy and keep its behavior identical. `tests/runtime-files.test.ts` may import `src/runtime-files.ts` because it depends only on Node.js APIs. `vitest.config.ts` aliases `obsidian` to `tests/mocks/obsidian.ts`, so `tests/frontmatter.test.ts` can import `src/vault-tools.ts` directly. Keep the mock minimal and add to it only what a test needs.

Add regression tests for config preservation, path handling, write-if-changed behavior, and platform-specific paths when those areas change. CI must pass on all three operating systems.

## Release contract

Read `docs/RELEASING.md` before a release. A valid release requires:

- matching versions in `manifest.json`, `package.json`, and the root entry in `package-lock.json`
- a matching `versions.json` compatibility entry
- a `vX.Y.Z` Git tag and release name
- built `main.js`, `manifest.json`, and `styles.css` attached to the GitHub Release
- a README version badge, summary line, and changelog entry for the release

Do not require `bridge.js` as a release asset. The production bundle contains it.

## Working conventions

- Keep changes scoped and preserve existing behavior unless the task explicitly changes it.
- Inspect the working tree before editing. Do not discard unrelated user changes.
- Use UTF-8, LF line endings, strict TypeScript, and the existing code style.
- Update `main.js` with `npm run build` when source changes affect the plugin bundle.
- Run typecheck, tests, build, and `git diff --check` before opening a PR.
- Do not force-push or hard-reset shared work.
- Do not read or commit local MCP client configuration files because they may contain secrets.

## Agent resources

- `.agents/README.md` indexes the agent-specific files.
- `.agents/rules/tests-and-scripts.md` contains test and generated-file rules.
- `.agents/commands/release.md` contains the version bump procedure.
- `.agents/agents/vault-security-reviewer.md` contains the security review checklist.
- `.agents/skills/` contains reusable project-local skills copied from the shared `Projetos/Skills` directory.

When an instruction conflicts with the code, verify the current behavior and update this guide in the same PR.
