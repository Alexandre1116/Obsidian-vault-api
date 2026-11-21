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

`limit` defaults to 2,000 and is capped at 5,000. The response includes `total`, `shown`, and `truncated`. Synology and recycle-bin metadata (`@eaDir`, `#recycle`, `.trash`) is left out of the listing; when anything is left out the response also reports `skipped_metadata`.

### `read_file`

Reads a file by path. Optional `encoding: "base64"` forces raw base64 text for images and binary files.

- SVG files return text, up to the 5 MB text limit.
- Raster images return MCP image content. Images over 4 MB are resized only when their dimensions exceed the size tier's maximum.
- Known binary files return base64, with inline content for files up to 5 MB by default.
- Other readable files return text when they fit the 5 MB text limit and base64 up to 32 MB above it; above 32 MB the file is refused with guidance (`run_local_command` with `grep`/`head`), so a large media or backup file is never decoded in the vault process.

Every size decision is taken from the file that is actually open, not from the vault listing. A note that grew after the listing was taken is refused or returned as base64 by its current size, and at most the applicable limit is ever allocated: the read opens the file, checks it with `fstat`, and reads in chunks. A read that cannot finish in 10 seconds — a slow NAS mount, an unresponsive cloud placeholder — ends with an explicit error instead of hanging the call.

Where the bytes come from: a file open in an Obsidian editor is read from Obsidian's cache, so unsaved edits are visible; any other file is read from disk.

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

Decoded binary data is limited to 32 MB, for both writes and base64 read results, and the same limit is used in both directions so anything a client can read it can also write back.

The payload is validated **before** it is decoded: it must use the base64 alphabet, must not contain whitespace or line breaks, must have a length that is a multiple of four, and must have at most two `=` padding characters. The decoded length is then checked against the declared size. This matters because `Buffer.from(text, "base64")` silently drops invalid characters, so an unvalidated string can decode to something much larger than the size estimate, or be written into the vault as garbage.

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

Searches file names and readable text content. File-name matches are returned first. Content matches include up to three matching lines per file, each truncated to 500 characters. Results are capped at 50, and the query is limited to 500 characters.

The scan is bounded. Files are skipped before they are opened when they are Synology or recycle-bin metadata (`@eaDir`, `#recycle`, `.trash`), a known binary or image format, or larger than 2 MB. The current size is checked again immediately before each read, so a file that grew after the file listing was taken is skipped instead of allocated. Bytes are reserved before a read starts (listed size, topped up to the current size), so one call never decodes more than 32 MB in total even when every listed size was wrong; reads run at most 20 at a time. A 15 second wall-clock budget is also re-checked before every file, which keeps the scan clear of the 25 second tool timeout. When any budget stops the scan, a file cannot be read, or a file changed under the scan, the response sets `partial: true` and `note` explains why, so an incomplete answer is never presented as a complete one. The `skipped` object reports the counts per category: `metadata`, `too_large`, `binary`, `read_failed`, and `not_started`.

Content matching reads from disk with a hard per-file cap, so a large file can never be buffered; the trade-off is that **unsaved changes in an open Obsidian editor are not searched**. Save the note and it will match.

### `run_local_command`

Runs one program with the vault as its working directory:

```json
{"command":"node scripts/build-report.mjs"}
```

**No shell is involved.** The command string is split into a program and its arguments and started with `child_process.execFile`. `;`, `&&`, `||`, `|`, `&`, backticks, `$(…)`, `<` and `>` are therefore ordinary characters inside one argument: they cannot start a second program, because nothing interprets them. Quoting is defined by this plugin rather than inherited from a shell — `'…'` and `"…"` group an argument (which is how a path containing a space is passed) and `\` escapes one character; an unterminated quote is an error, not a guess. The program is limited to 2,000 characters, runs for at most 25 seconds, and has a 10 MB combined stdout/stderr buffer.

The program must match the comma-separated glob patterns in **Allowed commands**, and a pattern always matches the **whole command**: a bare `git` allows only `git` with no arguments, `git *` allows `git` with any arguments, `git status` allows exactly `git status`. The default pattern is `*`, which means no restriction at all: any program, with any arguments. When a list is configured, arguments must also stay inside the vault: absolute paths, `~`, drive paths and `..` segments are rejected, as are flags that execute or delete by themselves (`-exec`, `-execdir`, `-ok`, `-delete`, `-fprint`, `-fls`, `-files0-from`).

**The allowlist is not a sandbox, and treating it as one is a mistake.** An allowlisted program keeps everything described in its own manual: `grep -f FILE` reads a pattern file, `python -c` runs code, `pandoc --lua-filter` runs a filter, `git -c core.fsmonitor=…` runs a command. The child process is given a minimal environment (so the API key held by the plugin is never inherited), but a program that can open files can open files, and the working directory is the vault. List the smallest set of programs you actually need, prefer exact commands such as `git status` over `git *`, and never list anything that can execute code when the endpoint is reachable by clients you do not trust.

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
| Decoded binary write | 32 MB |
| Binary returned as base64 | 32 MB |
| Search query | 500 characters |
| Search file size | 2 MB |
| Search total bytes reserved per call | 32 MB |
| Search wall-clock budget | 15 seconds |
| Text returned by `read_file` | 5 MB |
| Shell command | 2,000 characters |
| Shell output buffer | 10 MB |
| Tool call timeout | 25 seconds |
