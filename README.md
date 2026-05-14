# Vault API — Obsidian MCP Plugin

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Version](https://img.shields.io/badge/version-0.1.1--alpha-orange)](https://github.com/Alexandre1116/Obsidian-vault-api/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.0%2B-purple)](https://obsidian.md)

> **Alpha v0.1.1** — work in progress. Expect breaking changes.

Connects your [Obsidian](https://obsidian.md) vault directly to [Claude Desktop](https://claude.ai/download) via the Model Context Protocol (MCP). No extra processes, no manual path configuration — the plugin **is** the MCP server.

```
Obsidian opens  →  plugin starts  →  MCP/SSE on 127.0.0.1:2768
Claude opens    →  reads config   →  connects to MCP
Claude                            →  reads, writes, and sees images in your vault
```

---

## Features

| Tool | Description |
|------|-------------|
| `list_files` | List vault files — filter by folder or extension |
| `read_file` | Read `.md` / `.txt` as text; images as **inline visuals** Claude can see. Large images (any size) are auto-resized. |
| `write_file` | Create or update a file |
| `delete_file` | Delete a file |
| `search` | Search by keyword across filenames and note content |

### Image support
Images of **any size** are handled automatically:
- **≤ 4 MB** — sent as-is
- **> 4 MB** — resized to max 2048 × 2048 px JPEG 90 % using Electron's Canvas API (loaded directly from disk, no memory limit)

---

## Requirements

- Obsidian **desktop** (v1.0.0+) — plugin is desktop-only
- Claude Desktop
- Node.js 18+ (for `mcp-remote`, used to bridge Claude Desktop to the SSE server)

---

## Installation

### 1 — Copy plugin files

Download the latest `obsidian-claude-mcp-vX.X.X.zip` from [Releases](https://github.com/Alexandre1116/Obsidian-vault-api/releases) and extract it.

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

### 2 — Enable in Obsidian

**Settings → Community plugins → disable Safe Mode → enable Vault API**

You should see in the console (`Ctrl+Shift+I`):
```
[vault-api] MCP server started on port 2768
```

### 3 — Connect Claude Desktop

**Settings → Vault API → Connect Claude**

The plugin writes the MCP entry into `claude_desktop_config.json` automatically.

### 4 — Restart Claude Desktop

Fully quit Claude Desktop (`Quit`, not just close the window) and reopen it.

---

## Plugin Settings

| Setting | Description |
|---------|-------------|
| **Connect Claude** | Auto-configures `claude_desktop_config.json` |
| **Auto-start** | Start the server when Obsidian loads (default: on) |
| **Port** | Port to listen on (default: 2768) |
| **API Key** | Auto-generated secret. Regenerate if compromised, then reconnect Claude |
| **Restart / Stop** | Manual server controls |

---

## Building from Source

```bash
git clone https://github.com/Alexandre1116/Obsidian-vault-api
cd Obsidian-vault-api
npm install
npm run build    # outputs main.js
```

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
- [ ] Frontmatter / metadata tool
- [ ] Create/rename folders
- [ ] BRAT support for easy updates
- [ ] Settings UI improvements
