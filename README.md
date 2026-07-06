# Vault API — Obsidian MCP Plugin

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Version](https://img.shields.io/badge/version-1.1.2-blue)](https://github.com/Alexandre1116/Obsidian-vault-api/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)](https://obsidian.md)

> **v1.1.2** — hotfix: bridge.js now lives in the OS temp dir, not the vault folder, to avoid cloud-sync interference.

Connects your [Obsidian](https://obsidian.md) vault to **any AI that supports MCP** — Claude Desktop, LM Studio, Ollama, Open WebUI, and others. No extra processes, no manual path configuration — the plugin **is** the MCP server, exposing a standard SSE endpoint on localhost.

```
Obsidian opens  →  plugin starts  →  MCP/SSE on 127.0.0.1:2768
AI client       →  connects       →  reads, writes, runs commands, sees images
```

### Compatible clients

| Client | How to connect |
|--------|---------------|
| **Claude Desktop** | Settings → Vault API → **Connect Claude** (automatic) |
| **LM Studio** | Add MCP server → URL: `http://127.0.0.1:2768/sse?key=<your-key>` |
| **Ollama / Open WebUI** | Point any MCP-compatible front-end to the same SSE URL |
| **Any MCP client** | SSE transport at `http://127.0.0.1:2768/sse` with `X-Api-Key` header or `?key=` query param |

---

## Features

| Tool | Description |
|------|-------------|
| `list_files` | List vault files — filter by folder or extension. Optional `limit` param (default 2000, max 5000). Returns `total` and `truncated` fields. |
| `read_file` | Read text files, view images inline, get binary data. Files ≤ 5 MB return base64 data directly. `encoding:"base64"` forces raw base64 text for images **and** binary files. |
| `write_file` | Create or update a text file |
| `write_binary` | Create or overwrite any binary file (images, docx, pdf…) from base64 data |
| `append_file` | Append text content to the end of an existing file |
| `delete_file` | Move a file to the system trash (recoverable) |
| `read_frontmatter` | Read a markdown file's YAML frontmatter as parsed key-value pairs |
| `update_frontmatter` | Set, update, or delete frontmatter fields (pass `null` to delete a key) |
| `create_folder` | Create a new folder |
| `delete_folder` | Move a folder to the system trash (recoverable) |
| `rename_folder` | Rename or move a folder |
| `search` | Keyword search across filenames and note content |
| `run_local_command` | Run a shell command directly on your machine inside the vault folder |

### Image support

Images of **any size** are handled automatically:

| File size | Max dimension | Format |
|-----------|--------------|--------|
| ≤ 4 MB | Original | As-is |
| 4 MB – 20 MB | 1024 px | JPEG 85 % |
| 20 MB – 100 MB | 800 px | JPEG 85 % |
| > 100 MB | 512 px | JPEG 85 % |

Images load directly from disk via Electron's Canvas API — no Node.js heap pressure.
SVG files are returned as text (XML).

### Binary file access

Binary files (pdf, docx, zip, etc.) smaller than **5 MB** are returned as base64-encoded data directly in the `read_file` response. Larger files return metadata only — use `encoding:"base64"` to force full data retrieval, or `run_local_command` to process them locally.

The `/raw` HTTP endpoint serves any vault file as raw bytes (authenticated), allowing scripts running inside Claude's execution sandbox to `fetch()` vault files directly — no base64 overhead.

---

## Requirements

- Obsidian **desktop** (v1.0.0+) — plugin is desktop-only
- Any MCP-compatible AI client (Claude Desktop, LM Studio, Open WebUI, etc.)
- Node.js 18+ — only required for **Claude Desktop** (uses the included `bridge.js` to bridge stdio → SSE). Not needed for clients with native SSE/HTTP MCP support.

---

## Installation

Pick whichever method you prefer — both install the same plugin.

### Option A — BRAT (recommended, auto-updates)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tool) installs the plugin straight from this GitHub repo and checks for updates automatically.

1. Install **BRAT** from Obsidian's Community Plugins browser and enable it.
2. **Settings → BRAT → Add Beta plugin** (or run the command *BRAT: Add a beta plugin for testing*).
3. Paste the repo URL:
   ```
   https://github.com/Alexandre1116/Obsidian-vault-api
   ```
4. Leave "Version" empty to always track the latest release, enable it, and click **Add Plugin**.
5. **Settings → Community plugins → enable Vault API.**

BRAT re-downloads `main.js` on every update, and the plugin automatically writes `bridge.js` into its own folder on load — no manual file copying, ever.

### Option B — Manual install

Download the latest `obsidian-vault-api-vX.X.X.zip` from [Releases](https://github.com/Alexandre1116/Obsidian-vault-api/releases) and extract it.

Copy the `vault-api` folder into your vault's plugin directory:

```
<your-vault>/
└── .obsidian/
    └── plugins/
        └── vault-api/        ← copy here
            ├── main.js
            ├── manifest.json
            └── styles.css
```

> On Windows, enable **View → Hidden items** to see the `.obsidian` folder.
>
> `bridge.js` (needed for Claude Desktop) doesn't need to be copied by hand — the plugin writes it into this same folder the first time it loads.

Then **Settings → Community plugins → disable Safe Mode → enable Vault API**.

### Enable and connect Claude Desktop

You should see in the console (`Ctrl+Shift+I`):
```
[vault-api] MCP server started on port 2768
```

**Settings → Vault API → Connect Claude**

The plugin writes the MCP entry into `claude_desktop_config.json` automatically. The API key is passed securely via an environment variable (`VAULT_API_KEY`) — it is never exposed as a command-line argument.

Fully quit Claude Desktop (`Quit`, not just close the window) and reopen it to apply the change.

---

## Plugin Settings

| Setting | Description |
|---------|-------------|
| **Connect Claude** | Auto-configures `claude_desktop_config.json` |
| **Auto-start** | Start the server when Obsidian loads (default: on) |
| **Port** | Port to listen on (default: 2768) |
| **API Key** | Auto-generated secret. Regenerate if compromised, then reconnect Claude |
| **Restart / Stop** | Manual server controls |

The `/health` endpoint (`http://127.0.0.1:2768/health`) returns `{ status, version }` publicly. Authenticated requests additionally return `vault`, `port`, and `sessions`.

---

## Upgrading

- **BRAT:** updates automatically (or trigger one manually via **BRAT → Check for updates**).
- **Manual:** replace `main.js` (and `manifest.json`) with the files from the latest release, then reload the plugin in Obsidian (**Settings → Community plugins → Vault API → toggle off → toggle on**). `bridge.js` is rewritten automatically — no need to replace it by hand.

---

## Building from Source

```bash
git clone https://github.com/Alexandre1116/Obsidian-vault-api
cd Obsidian-vault-api
npm install
npm run build    # outputs main.js
```

---

## Changelog

### v1.1.2 — Hotfix

- **Fix:** `bridge.js` is no longer written inside the vault's plugin folder — it's now written to the OS temp directory instead. Vaults are frequently stored inside cloud-sync folders (OneDrive, Synology Drive, Google Drive, etc.), and those sync clients can leave a just-written file un-materialized long enough that Claude Desktop's `node <path>` spawn fails with `MODULE_NOT_FOUND`, even though the plugin reported the write as successful. The OS temp dir is always a genuine local path, so this removes the dependency on the vault's storage backend entirely.

### v1.1.1 — Hotfix

- **Fix:** `ensureBridgeFile()` no longer swallows write failures silently. If `bridge.js` can't be written (e.g. cloud-synced vault folders like OneDrive/Synology Drive briefly locking files), Obsidian now shows the real error instead of a false "Claude Desktop configured!" success message, and **Connect Claude** aborts instead of writing a config that points at a missing file.

### v1.1.0

- **New tools (6):** `read_frontmatter`, `update_frontmatter`, `create_folder`, `delete_folder`, `rename_folder`, `append_file`
- **Security:** command allowlist (glob patterns) for `run_local_command`; symlink traversal protection on all path-based tools
- **Fix:** stricter port validation; timeout cleanup for in-flight tool calls
- **BRAT support:** `bridge.js` is now embedded in `main.js` and written to the plugin folder automatically on load, so installs via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (which only fetches `main.js`/`manifest.json`/`styles.css`) work out of the box
- **Quality:** unit tests (vitest) and GitHub Actions CI for build + test

### v1.0.0 — First stable release

- **Security:** API key passed via `VAULT_API_KEY` env var instead of CLI arg — no longer visible in `ps aux`
- **Security:** `/health` endpoint restricts vault name and session count to authenticated requests
- **Fix:** `delete_file` now moves files to the system trash instead of permanently deleting them
- **Fix:** Binary files ≤ 5 MB return base64 data directly in `read_file`; `encoding:"base64"` now works for binary files as well as images
- **Fix:** `run_local_command` child process is now killed after the 25 s timeout instead of running indefinitely in the background
- **Fix:** Server restart notice only appears when the server actually started successfully
- **Perf:** `search` reads files in concurrent batches of 20 (significantly faster on large vaults)
- **Perf:** `list_files` is now paginated — returns `{ files, total, shown, truncated }` with a configurable `limit` (default 2000, max 5000)
- **UX:** Input validation errors now display correct size units (bytes / KB / MB)

### v0.2.0
- **New tool `write_binary`** — create or overwrite any binary file (images, docx, pdf…) from base64 data
- **New tool `run_local_command`** — execute shell commands directly on the user's machine inside the vault directory, bypassing the cloud sandbox
- **New `/raw` HTTP endpoint** — serves vault files as raw bytes so scripts can `fetch()` them without base64 overhead
- **`read_file` `encoding:"base64"` param** — forces raw base64 text output for images, enabling scripting use cases
- `search` now skips binary/image files (faster, less noise)
- `BINARY_EXTS` guard avoids failed text-decode on pdf, docx, mp4, etc.
- Improved MIME type table (Office formats, audio, video)

### v0.1.4
- Fixed **server disconnect** when reading large images — Canvas timeout reduced to 15 s, global 25 s tool safety wrapper added
- **Tiered resize**: files > 100 MB → 512 px, > 20 MB → 800 px, default → 1024 px
- JPEG quality 85 %

### v0.1.3
- `read_file` on images now includes a text companion block with path, filename, `![[]]` embed syntax

### v0.1.2
- Fixed **"Tool result could not be submitted"** — SSE keep-alive pings every 15 s
- Fixed **Check /health** button — `/health` is now public

### v0.1.1
- Images of any size supported via Electron Canvas API resize
- SVG returned as text; HTTP server timeouts disabled

### v0.1.0
- Initial alpha release

---

## License

[![License: CC BY-NC-SA 4.0](https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](LICENSE).

| | |
|---|---|
| ✅ **Share** | Copy and redistribute in any medium or format |
| ✅ **Adapt / Remix** | Transform and build upon the material |
| ✅ **Free for personal use** | Non-commercial use by anyone |
| ❌ **No commercial use** | Companies, revenue-generating use not permitted |
| 📝 **Attribution required** | Credit the original author (Alexandre Ramos) |
| 🔄 **ShareAlike** | Remixes must use the same CC BY-NC-SA 4.0 license |

---

## Roadmap

- [ ] Obsidian Search API integration (tags, backlinks)
- [ ] Settings UI improvements
