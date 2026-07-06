import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { VaultMcpServer } from "./mcp-server";
import { BRIDGE_JS_SOURCE } from "./bridge-source";
import * as fs     from "node:fs";
import * as path   from "node:path";
import * as os     from "node:os";
import * as crypto from "node:crypto";

interface Settings { port: number; apiKey: string; autoStart: boolean; allowedCommands: string; }
const DEFAULTS: Settings = { port: 2768, apiKey: "", autoStart: true, allowedCommands: "*" };

function generateKey() { return crypto.randomBytes(24).toString("hex"); }

function claudeConfigPath(): string {
  if (process.platform === "win32")
    return path.join(process.env.APPDATA!, "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "Claude", "claude_desktop_config.json"
  );
}

export default class VaultApiPlugin extends Plugin {
  declare settings: Settings;
  private server: VaultMcpServer | null = null;

  async onload() {
    await this.loadSettings();
    if (!this.settings.apiKey) { this.settings.apiKey = generateKey(); await this.saveSettings(); }
    const bridgeErr = this.ensureBridgeFile();
    if (bridgeErr) new Notice(`Vault API: could not write bridge.js — ${bridgeErr}`, 8000);
    if (this.settings.autoStart) await this.startServer();

    // Self-heal: if claude_desktop_config.json already has an "obsidian"
    // entry (from a previous "Connect Claude"), keep its bridge path and API
    // key in sync automatically. Never adds a new entry here — only "Connect
    // Claude" does that — so this can't surprise a user who never opted in.
    // This is what would have prevented the 1.1.2 bridge.js relocation from
    // silently breaking existing connections.
    const syncResult = this.syncClaudeConfig(/* onlyIfPresent */ true);
    if (syncResult === "updated") {
      new Notice("Vault API: Claude Desktop config was out of date (bridge path or key had changed) — fixed automatically. Restart Claude Desktop to apply.", 9000);
    } else if (syncResult !== "unchanged" && syncResult !== "skipped") {
      console.warn("[vault-api] could not self-heal Claude Desktop config:", syncResult);
    }

    this.addSettingTab(new SettingsTab(this.app, this));
    this.addCommand({ id: "connect-claude",  name: "Connect to Claude Desktop", callback: () => this.connectClaude() });
    this.addCommand({ id: "restart-server",  name: "Restart MCP server",        callback: () => this.restartServer() });
  }

  // BRAT only fetches manifest.json/main.js/styles.css from a release, so
  // bridge.js (needed by Claude Desktop) is embedded in main.js and written
  // out here — this also keeps it in sync on every upgrade.
  //
  // It is written to the OS temp dir, NOT the vault's plugin folder: vaults
  // are often stored inside cloud-sync folders (OneDrive, Synology Drive,
  // Google Drive, etc.), and those sync clients can leave a just-written
  // file un-materialized (placeholder/reparse point) for long enough that
  // Claude Desktop's `node <path>` spawn fails with MODULE_NOT_FOUND even
  // though the write itself reported success. The OS temp dir is always a
  // genuine local path.
  private getBridgeDir(): string {
    return path.join(os.tmpdir(), "obsidian-vault-api-bridge");
  }

  // Returns null on success, or an error message on failure. Callers must
  // check the result instead of assuming the file is there afterwards.
  private ensureBridgeFile(): string | null {
    const bridgePath = path.join(this.getBridgeDir(), "bridge.js");
    try {
      fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
      fs.writeFileSync(bridgePath, BRIDGE_JS_SOURCE, "utf-8");
      if (!fs.existsSync(bridgePath)) return `${bridgePath} was not created`;
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[vault-api] could not write bridge.js:", msg);
      return msg;
    }
  }

  async onunload() { await this.stopServer(); }

  async startServer(): Promise<void> {
    if (this.server) return;
    this.server = new VaultMcpServer(this.app, this.settings.port, this.settings.apiKey, this.settings.allowedCommands);
    try {
      await this.server.start();
      console.log(`[vault-api] MCP server started on port ${this.settings.port}`);
    } catch (err) {
      new Notice(`Vault API: could not start on port ${this.settings.port}. Is it already in use?`);
      this.server = null;
    }
  }

  async stopServer(): Promise<void> {
    if (!this.server) return;
    await this.server.stop();
    this.server = null;
  }

  async restartServer() {
    await this.stopServer();
    await this.startServer();
    if (this.isRunning())
      new Notice(`Vault API: restarted on port ${this.settings.port}`);
  }

  isRunning() { return this.server !== null; }

  connectClaude() {
    // Restart server so it uses the current API key (fixes stale-key after regenerate)
    this.restartServer();

    const result = this.syncClaudeConfig(/* onlyIfPresent */ false);
    if (result === "added" || result === "updated") {
      new Notice("Claude Desktop configured! Restart Claude to apply.", 6000);
    } else if (result === "unchanged") {
      new Notice("Claude Desktop is already configured correctly.", 4000);
    } else {
      new Notice(`Vault API: could not write config — ${result}`, 8000);
    }
  }

  // Writes or updates the "obsidian" entry in claude_desktop_config.json
  // without touching any other MCP server the user has configured there.
  // When onlyIfPresent is true, does nothing unless an "obsidian" entry
  // already exists — used by the silent on-load self-heal, so it can never
  // inject a new entry the user hasn't explicitly opted into via
  // "Connect Claude" at least once.
  private syncClaudeConfig(onlyIfPresent: boolean): "added" | "updated" | "unchanged" | "skipped" | string {
    const bridgeErr = this.ensureBridgeFile();
    if (bridgeErr) return `could not write bridge.js — ${bridgeErr}`;
    const bridgePath = path.join(this.getBridgeDir(), "bridge.js");

    const cfgPath = claudeConfigPath();
    let cfg: Record<string, unknown> = {};
    if (fs.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); }
      catch (e) { return `could not parse Claude config — ${e instanceof Error ? e.message : e}`; }
    }
    const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
    const existing = servers["obsidian"];
    if (!existing && onlyIfPresent) return "skipped";

    const desired = {
      command: "node",
      args: [bridgePath, String(this.settings.port)],
      env: { VAULT_API_KEY: this.settings.apiKey },
    };
    if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return "unchanged";

    servers["obsidian"] = desired;
    cfg.mcpServers = servers;
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    } catch (err) {
      return `could not write config — ${err instanceof Error ? err.message : err}`;
    }
    return existing ? "updated" : "added";
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

// ── Settings tab ──────────────────────────────────────────────────────────
class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultApiPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault API — Claude MCP" });

    // Status badge
    const badge = containerEl.createEl("p");
    const refresh = () => {
      badge.textContent = this.plugin.isRunning()
        ? `Running on port ${this.plugin.settings.port}`
        : "Stopped";
      badge.style.color = this.plugin.isRunning() ? "var(--color-green)" : "var(--color-red)";
    };
    refresh();

    // Connect button
    new Setting(containerEl)
      .setName("Connect to Claude Desktop")
      .setDesc("Writes the MCP server entry into claude_desktop_config.json. Restart Claude after.")
      .addButton(b => b.setButtonText("Connect Claude").setCta().onClick(() => this.plugin.connectClaude()));

    // Auto-start
    new Setting(containerEl)
      .setName("Auto-start")
      .setDesc("Start the MCP server when Obsidian loads.")
      .addToggle(t => t.setValue(this.plugin.settings.autoStart).onChange(async v => {
        this.plugin.settings.autoStart = v; await this.plugin.saveSettings();
      }));

    // Allowed commands
    new Setting(containerEl)
      .setName("Allowed commands")
      .setDesc("Glob patterns for allowed shell commands, separated by commas. Use '*' to allow all (default). Examples: 'node *, python *, git *'")
      .addText(t => t.setValue(this.plugin.settings.allowedCommands).onChange(async v => {
        this.plugin.settings.allowedCommands = v || "*";
        await this.plugin.saveSettings();
      }));

    // Port
    new Setting(containerEl)
      .setName("Port")
      .setDesc("Port to listen on (default 2768). Requires restart to take effect.")
      .addText(t => t.setValue(String(this.plugin.settings.port)).onChange(async v => {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0 && n < 65536) { this.plugin.settings.port = n; await this.plugin.saveSettings(); }
      }));

    // API key
    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Auto-generated. Regenerating requires reconnecting Claude.")
      .addText(t => t.setValue(this.plugin.settings.apiKey).inputEl.setAttribute("readonly", "true"))
      .addButton(b => b.setButtonText("Regenerate").setWarning().onClick(async () => {
        this.plugin.settings.apiKey = generateKey();
        await this.plugin.saveSettings();
        await this.plugin.restartServer();   // update in-memory key immediately
        new Notice("Key regenerated. Click 'Connect Claude' again.");
        this.display();
      }));

    // Server controls
    new Setting(containerEl)
      .setName("Server control")
      .addButton(b => b.setButtonText("Restart").onClick(async () => {
        await this.plugin.restartServer(); refresh();
      }))
      .addButton(b => b.setButtonText("Stop").setWarning().onClick(async () => {
        await this.plugin.stopServer(); refresh();
      }));

    // URL info box
    const box = containerEl.createEl("div");
    box.style.cssText = "margin-top:16px;padding:12px;background:var(--background-secondary);border-radius:6px;" +
                        "font-family:var(--font-monospace);font-size:0.82em;word-break:break-all;";
    box.createEl("div", { text: `MCP URL: http://127.0.0.1:${this.plugin.settings.port}/sse?key=${this.plugin.settings.apiKey}` });
    box.createEl("div", {
      text: "Tip: you can also authenticate via the X-Api-Key request header instead of the ?key= query parameter.",
      attr: { style: "margin-top:6px;opacity:0.65;font-family:var(--font-text);font-size:0.9em;" },
    });

    // Health link — /health is now public, no key needed
    const link = containerEl.createEl("a", {
      text: "Check /health",
      href: `http://127.0.0.1:${this.plugin.settings.port}/health`,
    });
    link.style.cssText = "display:block;margin-top:8px;font-size:0.85em;";
    link.target = "_blank";
  }
}
