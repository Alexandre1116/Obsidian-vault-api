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
| `search` | Searches filenames and readable file content, skipping metadata, media, and oversized files. |
| `run_local_command` | Runs one allowlisted program in the vault directory, with no shell involved. |

Images larger than 4 MB are resized when needed and returned as JPEG image content. SVG files are returned as text. Binary files up to 5 MB are returned inline by default; pass `encoding: "base64"` to request base64 explicitly. Text is returned up to 5 MB, base64 up to 32 MB decoded, and `search` never opens a file larger than 2 MB, a known binary or image format, or Synology and recycle-bin metadata such as `@eaDir` and `#recycle`. When a byte or time budget stops a scan, or a file cannot be read, the response says `partial: true` instead of looking complete. See [`docs/API.md`](docs/API.md) for limits and response details.

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

The key is generated locally. If it is regenerated, reconnect every configured client. The default `*` command pattern lets any MCP client that holds the key run any program on this machine, so restrict it when that access is not needed.

## Security and data access

- The server binds to `127.0.0.1`, not a network interface.
- Every non-preflight route except the basic `/health` response requires the API key.
- Vault paths must be relative. Absolute paths, drive letters, null bytes, and `..` traversal are rejected.
- File access checks the resolved path to prevent symlinks from escaping the vault.
- File and folder deletion uses the system trash and is recoverable.
- The bridge stores the key in the child process environment as `VAULT_API_KEY`.
- Tool output never contains the API key, so it does not end up in a model conversation.
- The `run_local_command` tool executes on the local machine. Review the allowlist before sharing the API key with another client. No shell is used: the command is tokenized and started with `execFile`, so `;`, `&&`, `||`, `|`, `&`, backticks, `$`, `<` and `>` are literal characters and cannot start a second program. Each pattern must match the whole command: `git status` allows only that command, `git` alone allows `git` with no arguments, and `git *` allows any arguments. With a list configured, arguments must also stay inside the vault (absolute paths, `~`, drive paths and `..` are rejected), self-executing flags such as `-exec` and `-delete` are rejected, and the child process gets a minimal environment rather than the plugin's, so the API key is never inherited. None of that is a sandbox: an allowlisted program keeps everything its own manual describes, which is why a wildcard pattern such as `git *`, `node *` or `python *` grants arbitrary execution through that program. Use exact patterns when you need a real restriction.

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
- `run_local_command` no longer uses a shell. The command is tokenized and started with `execFile`, so `;`, `&&`, `||`, `|`, `&`, backticks, `$(…)`, `<` and `>` are literal characters that cannot start a second program. Quoting (`'…'`, `"…"`, `\`) is defined by the plugin so paths containing spaces still work, and an unterminated quote is an error. The child gets a minimal environment, so the API key in the plugin's environment is never inherited.
- Documented plainly that the command allowlist is **not** a sandbox: an allowlisted program keeps its own capabilities (`grep -f`, `python -c`, Pandoc filters, `git -c`), and `Allowed commands = *` means no restriction at all.
- Command allowlist patterns match the whole command. A bare pattern such as `git` no longer allows `git` with any arguments; write `git *` for that, or list exact commands such as `git status`.
- A `run_local_command` call whose program exits non-zero, is killed, times out or cannot be started now returns `isError: true`. The stdout/stderr are still included, but a client no longer has to parse the text to learn that the command failed.
- Size limits below one megabyte are printed in kilobytes (`limit 64 KB` rather than `limit 0.1 MB`).
- Rewrote `read_frontmatter` and `update_frontmatter` on Obsidian's YAML parser and `processFrontMatter`. Updates no longer drop lists, nested values, or hyphenated keys. `update_frontmatter` requires Obsidian 1.4.4 or newer.
- Made type-check failures fail CI.
- Skipped Synology and recycle-bin metadata (`@eaDir`, `#recycle`, `.trash`) in `list_files` and `search`, and reported the count in the response.
- Widened the binary extension list so disk images, OpenDocument files, database dumps, packet captures, and unrenderable image formats are never decoded as text or pushed through the image canvas.
- Bounded `search`: 2 MB per file, a strict 32 MB aggregate per call enforced by byte reservations (the current size is re-checked before each read, so a file that grows after the file listing is skipped rather than allocated), at most 20 reads at a time, a 15 second wall-clock budget re-checked per file, and 500 characters per matching line. Content matching now reads through a capped file handle instead of `vault.read`, so a file can never be buffered whole; the trade-off is that unsaved changes in an open editor are not searched. Responses now include `partial`, `skipped` (including `read_failed` and `not_started`), `scanned_files`, and `bytes_scanned` so incomplete results are labelled instead of looking final.
- Bounded `read_file`: text (including SVG) is capped at 5 MB, base64 at 32 MB, and both limits are now enforced by the reader rather than by the size in the vault listing. The file size is taken from the open handle and the bytes are read in chunks, so a note that grew after it was listed is refused or returned as base64 by its real size instead of being buffered whole. A read that exceeds 10 seconds (a slow NAS mount, an unresponsive cloud placeholder) ends with an error instead of hanging. A file open in an editor is still read from Obsidian's cache, so unsaved edits are visible there.
- Validated `write_binary` payloads before decoding them: base64 alphabet, no whitespace or line breaks, length a multiple of four, at most two padding characters, and the decoded length must match the declared size. `Buffer.from(text, "base64")` silently drops invalid characters, so an unvalidated payload could decode far above the limit or write garbage into the vault.
- Centralized path validation in the file layer (`validateVaultPath`): type, length, null bytes, absolute paths, drive letters, UNC paths and `..` segments are now rejected by every tool, including the folder tools, instead of only at the HTTP boundary. `read_file`, `search` and the folder tools also contain the resolved path against the vault root with a separator-aware check, so a sibling such as `/vault-evil` is never treated as inside `/vault`.
- Lowered the base64 read and write limit from 500 MB to 32 MB decoded. A 500 MB base64 result allocated enough memory to crash the renderer, which is the same failure mode this change removes elsewhere.

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
