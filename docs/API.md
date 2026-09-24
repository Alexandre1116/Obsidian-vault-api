# Vault API reference

This document describes the local HTTP/SSE server and the MCP tools exposed by Vault API 1.3.0.

## Connection

The default base URL is:

```text
http://127.0.0.1:2768
```

The server binds to loopback only. Change the port in **Settings -> Vault API** if another application already uses it.

### Authentication

Send the generated API key in either form:

```http
X-Api-Key: <your-api-key>
```

or:

```text
?key=<your-api-key>
```

The header is preferable for scripts because query strings can appear in logs. The plugin settings page shows the current key and SSE URL. Regenerating the key invalidates existing client configurations until they are reconnected.

The built-in connectors use these default config paths:

- Claude Code CLI: `~/.claude.json`.
- Claude Desktop on Windows: `%APPDATA%/Claude/claude_desktop_config.json`.
- Claude Desktop on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`.
- Claude Desktop on Linux: `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`, falling back to `~/.config/Claude/claude_desktop_config.json`.
- ChatGPT app / Codex CLI and app: `~/.codex/config.toml`.
- Google Antigravity: first existing path among `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity/mcp_config.json`.

### HTTP routes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | Optional | Returns `status` and `version`. Authenticated requests also include `vault`, `port`, and active `sessions`. |
| `GET` | `/sse` | Required | Opens an MCP Server-Sent Events connection. The transport advertises `/message` as its POST endpoint. |
| `POST` | `/message?sessionId=<id>` | Required | Sends an MCP message for an existing SSE session. |
| `GET` | `/raw?path=<vault-relative-path>` | Required | Returns a vault file as raw bytes with `application/octet-stream`. |
| `OPTIONS` | Any path | No | Handles the CORS preflight response without authentication. |

Example health response without authentication:

```json
{"status":"ok","version":"1.3.0"}
```

Example generic SSE URL:

```text
http://127.0.0.1:2768/sse?key=<your-api-key>
```

## MCP tools

All paths are relative to the vault. The server rejects absolute paths, drive letters, null bytes, `..` path segments, and paths longer than 1000 characters.

### `list_files`

Lists files and metadata. Optional arguments:

```json
{
  "folder": "Projects",
  "extension": "md",
  "limit": 100
}
```

`limit` defaults to 2,000 and is capped at 5,000. The response includes `total`, `shown`, and `truncated`.

### `read_file`

Reads a file by path. Optional `encoding: "base64"` forces raw base64 text for images and binary files.

- SVG files return text.
- Raster images return MCP image content. Images over 4 MB are resized only when their dimensions exceed the size tier's maximum.
- Known binary files return base64, with inline content for files up to 5 MB by default.
- Other readable files return text, with a binary fallback when Obsidian cannot decode them as text.

### `write_file`

Creates or replaces a text file:

```json
{"path":"Notes/idea.md","content":"# Idea\n"}
```

Parent folders are created when needed. Content is limited to 50 MB.

### `write_binary`

Creates or replaces a file from base64 data:

```json
{"path":"assets/logo.png","base64Data":"<base64>"}
```

Decoded binary data is limited to 500 MB. The base64 input is limited to about 700 MB.

### `append_file`

Appends text to an existing file. The appended content is limited to 50 MB.

### `delete_file`

Moves an existing file to the system trash. It does not permanently delete the file.

### `read_frontmatter`

Reads the frontmatter at the start of a Markdown file with Obsidian's YAML parser and returns the parsed values, the raw frontmatter, and `hasFrontmatter`. Lists, numbers, and nested values keep their YAML types. Invalid YAML returns an error.

### `update_frontmatter`

Sets or removes frontmatter fields. Use `null` to remove a field:

```json
{
  "path":"Notes/idea.md",
  "updates":{"status":"done","draft":null}
}
```

If the file has no frontmatter, the tool creates it from non-null updates. Fields that are not listed in `updates` are preserved. This tool uses Obsidian's `processFrontMatter` and requires Obsidian 1.4.4 or newer.

### `create_folder`

Creates a vault folder. Calling it for an existing folder returns `already_exists`.

### `delete_folder`

Moves an existing folder and its contents to the system trash.

### `rename_folder`

Renames or moves a folder within the vault:

```json
{"path":"Projects/Old","newPath":"Projects/Current"}
```

Both paths must be vault-relative and must not contain `..` segments.

### `search`

Searches file names and readable text content. File-name matches are returned first. Content matches include up to three matching lines per file. Results are capped at 50, and the query is limited to 500 characters.

### `run_local_command`

Runs a shell command with the vault as its working directory:

```json
{"command":"node scripts/build-report.mjs"}
```

The command must match the comma-separated glob patterns in **Allowed commands**. The default pattern is `*`. When the allowlist is not `*`, commands that contain `;`, `&`, `|`, `` ` ``, `$`, `<`, `>`, or a newline are rejected, because only the leading command is matched against the patterns. A command is limited to 2,000 characters, runs for at most 25 seconds, and has a 10 MB combined stdout/stderr buffer.

This tool runs on the same machine as Obsidian. Keep the API key private and use a narrow allowlist when arbitrary shell access is not required.

## Image handling

Raster images use the following size tiers when resizing is needed:

| File size | Maximum dimension | Output |
| --- | ---: | --- |
| Up to 4 MB | Original | Original MIME type |
| Over 4 MB through 20 MB | 1,024 px | JPEG, quality 85 |
| Over 20 MB through 100 MB | 800 px | JPEG, quality 85 |
| Over 100 MB | 512 px | JPEG, quality 85 |

The resize operation has a 15-second Canvas decode timeout. SVG is not rasterized.

## Errors and limits

Unauthenticated protected requests return HTTP 401. Missing resources return HTTP 404. Invalid paths and input values return HTTP 400 where the request is handled directly, or an MCP tool error for tool calls.

The main input limits are:

| Input | Limit |
| --- | ---: |
| Vault-relative path | 1,000 characters |
| Text content | 50 MB |
| Base64 input | About 700 MB |
| Decoded binary write | 500 MB |
| Search query | 500 characters |
| Shell command | 2,000 characters |
| Shell output buffer | 10 MB |
| Tool call timeout | 25 seconds |
