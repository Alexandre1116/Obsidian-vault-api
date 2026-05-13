# Vault API — Obsidian MCP Plugin

> **Alpha v0.1.0** — work in progress. Expect breaking changes.

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
| `read_file` | Read `.md` / `.txt` as text; `.png` / `.jpg` / `.webp` as **inline images** Claude can see |
| `write_file` | Create or update a file |
| `delete_file` | Delete a file |
| `search` | Search by keyword across filenames and note content |

---

## Requirements

- Obsidian **desktop** (v1.0.0+) — plugin is desktop-only
- Claude Desktop
- Node.js 18+ (for `mcp-remote`, used to bridge Claude Desktop to the SSE server)

---

## Installation

### 1 — Copy plugin files

Copy the `vault-api` folder into your vault's plugin directory:

```
<your-vault>/
└── .obsidian/
    └── plugins/
        └── vault-api/        ← create this
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
git clone https://github.com/aescola/obsidian-vault-api
cd obsidian-vault-api
npm install
npm run build    # outputs main.js
```

---

## License

Custom Non-Commercial License — see [LICENSE](LICENSE).

- ✅ Free for personal, non-commercial use
- ❌ Commercial / corporate use not permitted
- ✉️ To redistribute or modify, [request permission](https://github.com/aescola)

---

## Roadmap

- [ ] Obsidian Search API integration (tags, backlinks)
- [ ] Frontmatter / metadata tool
- [ ] Create/rename folders
- [ ] BRAT support for easy updates
- [ ] Settings UI improvements
