# Vault API, Obsidian MCP plugin

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/alexandre1116)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Version](https://img.shields.io/badge/version-1.3.0-blue)](https://github.com/Alexandre1116/Obsidian-vault-api/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)](https://obsidian.md)

> v1.3.0 adds separate CLI and app targets for Claude, ChatGPT app / Codex, and Google Antigravity.

Vault API runs a local [Model Context Protocol](https://modelcontextprotocol.io/) server inside Obsidian. MCP clients can read, write, search, and manage files in the open vault through HTTP and Server-Sent Events (SSE).

The server listens only on `127.0.0.1`, so it is intended for desktop use while Obsidian is running. The plugin also includes a local Node.js bridge for clients that use stdio instead of SSE.

## Choose the right project

Use this plugin when Obsidian is open on your desktop. For an always-on server, NAS, or Docker deployment, use [Obsidian Vault API Docker](https://github.com/Alexandre1116/Obsidian-Vault-API-Docker). The Docker project runs without the Obsidian desktop application.

## Requirements

- Obsidian desktop 1.0 or newer. This plugin is desktop-only.
- An MCP client such as Claude, ChatGPT app / Codex, Google Antigravity, LM Studio, Ollama, or Open WebUI.
- Node.js 18 or newer for the built-in Claude, ChatGPT app / Codex, and Google Antigravity bridges. Clients that connect directly over HTTP/SSE do not need Node.js.

Check Node.js with:

```bash
node --version
```

## Install

### BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs the plugin from GitHub Releases and can check for new versions.

1. Install and enable BRAT from Obsidian's Community Plugins browser.
2. Open **Settings -> BRAT -> Add Beta plugin**.
3. Add this repository:

   ```text
   https://github.com/Alexandre1116/Obsidian-vault-api
   ```

4. Leave the version field empty to follow the latest release, then add the plugin.
5. Enable **Vault API** under **Settings -> Community plugins**.

BRAT downloads `main.js`, `manifest.json`, and `styles.css` from a release. Do not copy `bridge.js`. The bridge is embedded in `main.js` and written to the operating system's temporary directory when the plugin loads.

To pin a beta or roll back, enter the exact release version in BRAT. To update, use **BRAT -> Check for updates**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the [Releases](https://github.com/Alexandre1116/Obsidian-vault-api/releases) page. Copy them to:

```text
<your-vault>/.obsidian/plugins/vault-api/
    main.js
    manifest.json
    styles.css
```

Enable **Vault API** in **Settings -> Community plugins**. `bridge.js` is embedded in the bundle and does not need to be copied.

## Connect a client

Start the plugin and check that Obsidian's developer console reports:

```text
[vault-api] MCP server started on port 2768
```

Open **Settings -> Vault API** to configure a client. Each built-in connector has a target selector and a separate optional config path. Leave a path empty to use the default.

### Claude Code CLI and Claude Desktop

In **Settings -> Vault API -> Claude**, select the target and click **Connect Claude**.

- Claude Code CLI defaults to `~/.claude.json`.
- Claude Desktop uses the platform-specific `claude_desktop_config.json` path:
  - Windows: `%APPDATA%/Claude/claude_desktop_config.json`
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Linux: `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`, falling back to `~/.config/Claude/claude_desktop_config.json`

The plugin adds or updates the `obsidian` entry and preserves unrelated settings and MCP servers. It passes the API key through `VAULT_API_KEY`, not as a command-line argument. Restart the selected Claude client after connecting.

### ChatGPT app / Codex

In **Settings -> Vault API -> ChatGPT app / Codex**, select **CLI** or **ChatGPT app / Codex**, then click **Connect ChatGPT app / Codex**.

Both targets default to:

```text
~/.codex/config.toml
```

The plugin updates the `[mcp_servers.obsidian]` TOML section and preserves other Codex settings. Restart the selected client after connecting.

### Google Antigravity

In **Settings -> Vault API -> Google Antigravity**, select **CLI** or **App / IDE**, then click **Connect Antigravity**.

The default lookup uses the first existing path below. If neither exists, the first path is used when creating the file.

```text
~/.gemini/config/mcp_config.json
~/.gemini/antigravity/mcp_config.json
```

The plugin preserves unrelated `mcpServers` entries. Restart Antigravity after connecting.

### Generic MCP clients

Use the authenticated SSE endpoint:

```text
http://127.0.0.1:2768/sse?key=<your-api-key>
```

Clients can send the key in the `X-Api-Key` header instead. The plugin displays the current URL and a public health-check link in its settings. The port and key are configurable.

The complete endpoint and tool reference is in [`docs/API.md`](docs/API.md).

## Tools

The server exposes these MCP tools:

| Tool | What it does |
| --- | --- |
| `list_files` | Lists vault files with optional folder, extension, and result-limit filters. |
| `read_file` | Reads text, SVG, raster images, and binary files. |
| `write_file` | Creates or replaces a text file. |
| `write_binary` | Creates or replaces a binary file from base64. |
| `append_file` | Appends text to an existing file. |
| `delete_file` | Moves a file to the system trash. |
| `read_frontmatter` | Reads YAML frontmatter from a Markdown file with Obsidian's parser. |
| `update_frontmatter` | Adds, changes, or removes frontmatter fields and keeps the others. Requires Obsidian 1.4.4 or newer. |
| `create_folder` | Creates a vault folder. |
| `delete_folder` | Moves a folder to the system trash. |
| `rename_folder` | Renames or moves a folder. |
| `search` | Searches filenames and readable file content. |
| `run_local_command` | Runs a shell command in the vault directory, subject to the allowlist. |

Images larger than 4 MB are resized when needed and returned as JPEG image content. SVG files are returned as text. Binary files up to 5 MB are returned inline by default; pass `encoding: "base64"` to request base64 explicitly. See [`docs/API.md`](docs/API.md) for limits and response details.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Claude target | Desktop app | Chooses Claude CLI or Claude Desktop. |
| Claude config paths | Empty | Separate optional paths for CLI and Desktop. |
| ChatGPT app / Codex target | CLI | Chooses Codex CLI or the app. |
| Codex config paths | Empty | Separate optional paths for CLI and app. |
| Google Antigravity target | App / IDE | Chooses CLI or app/IDE. |
| Antigravity config paths | Empty | Separate optional paths for CLI and app/IDE. |
| Node executable | `node` | Command or absolute path used by built-in bridges. |
| Auto-start | Enabled | Starts the server when Obsidian loads. |
| Allowed commands | `*` | Comma-separated glob patterns for `run_local_command`. |
| Port | `2768` | Local listening port. Restart the server after changing it. |
| API key | Generated | Secret used to authenticate HTTP requests. |

The key is generated locally. If it is regenerated, reconnect every configured client. The default `*` command pattern grants local shell access to any MCP client that has the key, so restrict it when the bridge does not need arbitrary commands.

## Security and data access

- The server binds to `127.0.0.1`, not a network interface.
- Every non-preflight route except the basic `/health` response requires the API key.
- Vault paths must be relative. Absolute paths, drive letters, null bytes, and `..` traversal are rejected.
- File access checks the resolved path to prevent symlinks from escaping the vault.
- File and folder deletion uses the system trash and is recoverable.
- The bridge stores the key in the child process environment as `VAULT_API_KEY`.
- Tool output never contains the API key, so it does not end up in a model conversation.
- The `run_local_command` tool executes on the local machine. Review the allowlist before sharing the API key with another client. When the allowlist is not `*`, commands containing shell operators (`;`, `&`, `|`, `` ` ``, `$`, `<`, `>`, or newlines) are rejected so an allowed command cannot chain another one.

## Build from source

```bash
git clone https://github.com/Alexandre1116/Obsidian-vault-api
cd Obsidian-vault-api
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` produces the committed `main.js` bundle. Every npm script synchronizes `bridge.js` into a generated source string first. `src/bridge-source.ts` is generated and should not be edited or committed.

The unit tests cover pure path, command, image, MIME, client-config, frontmatter, and runtime-file helpers. They do not load Obsidian's desktop runtime: `tests/mocks/obsidian.ts` stands in for it.

Maintainer release instructions are in [`docs/RELEASING.md`](docs/RELEASING.md).

## Changelog

### Unreleased

- Removed the API key from `read_file` image metadata and from the bridge's SSE URL. The bridge sends it only in the `X-Api-Key` header.
- Rejected shell operators in `run_local_command` when the command allowlist is restricted.
- Rewrote `read_frontmatter` and `update_frontmatter` on Obsidian's YAML parser and `processFrontMatter`. Updates no longer drop lists, nested values, or hyphenated keys. `update_frontmatter` requires Obsidian 1.4.4 or newer.
- Made type-check failures fail CI.

### v1.3.0

- Added built-in configuration for ChatGPT app / Codex using TOML.
- Added built-in configuration for Google Antigravity using JSON.
- Added separate CLI and app/IDE targets and config paths for Codex and Antigravity.
- Added a Claude Code CLI target alongside Claude Desktop.
- Preserved existing MCP entries while migrating older single-path settings.
- Kept the embedded bridge path stable across plugin updates and added a configurable Node executable for local bridges.
- Added release and API documentation for BRAT and generic MCP clients.

### v1.2.0

- Added a custom path setting for `claude_desktop_config.json`.

### v1.1.2

- Moved the generated bridge to the operating system's temporary directory to avoid cloud-sync filesystem issues.

### v1.1.1

- Reported bridge write failures instead of showing a false successful connection.

### v1.1.0

- Added frontmatter, folder, append, command allowlist, symlink protection, tests, CI, and BRAT-compatible bridge embedding.

### v1.0.0

- Added API-key authentication, raw file access, safe trash operations, binary file support, timeouts, and paginated file listing.

## License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See [`LICENSE`](LICENSE).

Commercial use is not permitted. Attribution to Alexandre Ramos is required, and derivative works must use the same license.

## Roadmap

- [ ] Obsidian Search API integration for tags and backlinks
- [ ] Settings UI improvements
