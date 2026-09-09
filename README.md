# Vault API - Obsidian MCP Plugin

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/alexandre1116)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Version](https://img.shields.io/badge/version-1.3.0-blue)](https://github.com/Alexandre1116/Obsidian-vault-api/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)](https://obsidian.md)

> **v1.3.0** - Adds separate CLI/app targets and config paths for Claude, ChatGPT app / Codex, and Google Antigravity.

Vault API exposes an Obsidian vault through a local MCP server. It supports Claude, ChatGPT app / Codex, Google Antigravity, LM Studio, Ollama, Open WebUI, and any other client that can use MCP over HTTP/SSE.

The plugin starts the server inside Obsidian. No separate server process is needed.

```text
Obsidian plugin  ->  MCP/SSE at http://127.0.0.1:2768
AI client        ->  reads, writes, searches, and manages vault files
```

## Compatible clients

| Client | Connection method |
| --- | --- |
| **Claude Code CLI** | Settings -> Vault API -> Claude -> choose **CLI** -> **Connect Claude** |
| **Claude Desktop** | Settings -> Vault API -> Claude -> choose **Desktop app** -> **Connect Claude** |
| **ChatGPT app / Codex CLI** | Settings -> Vault API -> ChatGPT app / Codex -> choose **CLI** -> **Connect ChatGPT app / Codex** |
| **ChatGPT app / Codex app** | Settings -> Vault API -> ChatGPT app / Codex -> choose **ChatGPT app / Codex** -> **Connect ChatGPT app / Codex** |
| **Google Antigravity CLI** | Settings -> Vault API -> Google Antigravity -> choose **CLI** -> **Connect Antigravity** |
| **Google Antigravity App / IDE** | Settings -> Vault API -> Google Antigravity -> choose **App / IDE** -> **Connect Antigravity** |
| **LM Studio** | Add an MCP server using the SSE URL below |
| **Ollama / Open WebUI** | Configure the same SSE URL in the MCP-compatible front-end |
| **Any MCP client** | Use the authenticated SSE endpoint below |

## Features

| Tool | Description |
| --- | --- |
| `list_files` | List vault files, optionally filtered by folder or extension. |
| `read_file` | Read text files, images, and binary files. |
| `write_file` | Create or update a text file. |
| `write_binary` | Create or overwrite binary files from base64 data. |
| `append_file` | Append text to an existing file. |
| `delete_file` | Move a file to the system trash. |
| `read_frontmatter` | Read a Markdown file's YAML frontmatter. |
| `update_frontmatter` | Set, update, or delete frontmatter fields. |
| `create_folder` | Create a folder. |
| `delete_folder` | Move a folder to the system trash. |
| `rename_folder` | Rename or move a folder. |
| `search` | Search filenames and note content. |
| `run_local_command` | Run an allowed shell command in the vault folder. |

### Images and binary files

Images are resized automatically when needed and are returned with MCP-compatible image content. SVG files are returned as text. Binary files smaller than 5 MB are returned as base64; use `encoding: "base64"` to request the full binary content.

The authenticated `/raw` endpoint serves vault files as raw bytes, which is useful for scripts running in an AI client's execution environment.

## Requirements

- Obsidian desktop 1.0 or newer. The plugin is desktop-only.
- Node.js 18 or newer on `PATH` for the built-in Claude, ChatGPT app / Codex, and Google Antigravity connectors. They launch the embedded bridge with `node`.
- Node.js is not required for clients that connect directly to the plugin's HTTP/SSE endpoint.

Check the Node.js installation with:

```bash
node --version
```

## Installation

### Option A - BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs a plugin from its GitHub Releases and can check for new releases automatically.

1. Install and enable **BRAT** from Obsidian's Community Plugins browser.
2. Open **Settings -> BRAT -> Add Beta plugin**.
3. Add this repository:

   ```text
   https://github.com/Alexandre1116/Obsidian-vault-api
   ```

4. Leave the version field empty to follow the latest release, then add the plugin.
5. Enable **Vault API** under **Settings -> Community plugins**.

BRAT installs the release assets `main.js`, `manifest.json`, and `styles.css`. The bridge source is embedded in `main.js`, so no `bridge.js` download or manual copy is required. On load, the plugin writes the bridge to a local operating-system temporary directory.

For a specific beta or rollback, enter an exact release version in BRAT. To receive future updates, keep the version empty and use **BRAT -> Check for updates** when needed.

### Option B - Manual install

Open the [Releases](https://github.com/Alexandre1116/Obsidian-vault-api/releases) page and download `main.js`, `manifest.json`, and `styles.css` from the release you want. Create this folder inside the vault and copy the three files into it:

```text
<your-vault>/.obsidian/plugins/vault-api/
    main.js
    manifest.json
    styles.css
```

Enable **Vault API** in **Settings -> Community plugins**. Do not copy `bridge.js`; it is embedded in the bundle and generated automatically.

## Connect a client

Start the plugin and confirm that the console contains:

```text
[vault-api] MCP server started on port 2768
```

### Claude CLI or Claude Desktop

Open **Settings -> Vault API -> Claude** and select the target:

- **CLI**: default config path is `~/.claude.json`.
- **Desktop app**: the plugin auto-detects the platform-specific `claude_desktop_config.json` path.

Each target has its own path textbox. Leave it empty to use the default or paste an absolute path if the config is stored elsewhere. Click **Connect Claude**, then restart the selected Claude client.

The plugin writes an `obsidian` MCP entry and preserves the other entries in the file. The bridge uses the `VAULT_API_KEY` environment variable; the key is not placed in a command-line argument.

### ChatGPT app / Codex

Open **Settings -> Vault API -> ChatGPT app / Codex** and select **CLI** or **ChatGPT app / Codex**. Each target has its own path textbox. The default for both is:

```text
~/.codex/config.toml
```

Click **Connect ChatGPT app / Codex** and restart the selected client. The plugin updates the `[mcp_servers.obsidian]` TOML section without removing other Codex settings.

### Google Antigravity

Open **Settings -> Vault API -> Google Antigravity** and select **CLI** or **App / IDE**. Each target has its own path textbox. The plugin checks these default locations, using the first existing file:

```text
~/.gemini/config/mcp_config.json
~/.gemini/antigravity/mcp_config.json
```

Click **Connect Antigravity** and restart the selected client. Other `mcpServers` entries are preserved.

### Generic MCP clients

The server listens on:

```text
http://127.0.0.1:2768/sse?key=<your-api-key>
```

Alternatively, send the API key in the `X-Api-Key` header. The port and key can be changed in the plugin settings. The public health check is:

```text
http://127.0.0.1:2768/health
```

## Plugin settings

| Setting | Description |
| --- | --- |
| **Connect Claude** | Writes or updates the selected Claude config. |
| **Claude target** | Selects Claude CLI or Claude Desktop. |
| **Claude config file path** | Custom path for the selected Claude target. |
| **Connect ChatGPT app / Codex** | Writes or updates the selected Codex TOML config. |
| **ChatGPT app / Codex target** | Selects Codex CLI or ChatGPT app / Codex. |
| **ChatGPT app / Codex config file path** | Custom path for the selected Codex target. |
| **Connect Antigravity** | Writes or updates the selected Antigravity JSON config. |
| **Antigravity target** | Selects CLI or App / IDE. |
| **Antigravity config file path** | Custom path for the selected Antigravity target. |
| **Auto-start** | Starts the MCP server when Obsidian loads. Enabled by default. |
| **Port** | Local server port. Defaults to `2768`. |
| **API Key** | Generated secret used to authenticate HTTP requests. |
| **Restart / Stop** | Manually controls the local server. |

When a key is regenerated, click each configured client's Connect button again.

## Updating

### BRAT

BRAT updates from GitHub Releases, not from arbitrary commits on the repository branch. To update automatically:

1. Leave the version field empty in BRAT.
2. Use **BRAT -> Check for updates** or wait for BRAT's scheduled check.
3. Reload the plugin if Obsidian does not reload it automatically.

The update keeps the plugin data and settings. It only replaces the release assets, and the bridge is regenerated automatically on the next load.

### Manual

Download the three assets from the new release and replace the files in `.obsidian/plugins/vault-api/`. Then toggle **Vault API** off and on in **Settings -> Community plugins**.

## Building from source

```bash
git clone https://github.com/Alexandre1116/Obsidian-vault-api
cd Obsidian-vault-api
npm ci
npm run typecheck
npm test
npm run build
```

The build outputs `main.js`. The source `bridge.js` is embedded during the build by `scripts/sync-bridge.mjs`.

Release instructions for maintainers are in [`docs/RELEASING.md`](docs/RELEASING.md).

## Changelog

### v1.3.0

- Added built-in connection for **ChatGPT app / Codex** with TOML config updates.
- Added built-in connection for **Google Antigravity** with JSON config updates.
- Added separate CLI and app/IDE target selectors and path textboxes for Codex and Antigravity.
- Added a **Claude CLI** target alongside Claude Desktop, with independent config paths.
- Preserved existing MCP entries and migrated the previous single-path settings.
- Updated BRAT installation and release documentation.

### v1.2.0

- Added a custom path setting for `claude_desktop_config.json`.

### v1.1.2 - Hotfix

- Moved the generated bridge to the operating-system temporary directory to avoid cloud-sync filesystem issues.

### v1.1.1 - Hotfix

- Showed bridge write failures instead of reporting a false successful connection.

### v1.1.0

- Added frontmatter, folder, append, command allowlist, symlink protection, tests, CI, and BRAT-compatible bridge embedding.

### v1.0.0 - First stable release

- Added secure API-key handling, authenticated raw file access, safe trash operations, binary file support, timeouts, and paginated file listing.

## License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See [LICENSE](LICENSE).

Commercial use is not permitted. Attribution to Alexandre Ramos is required, and derivative works must use the same license.

## Roadmap

- [ ] Obsidian Search API integration (tags and backlinks)
- [ ] Settings UI improvements
