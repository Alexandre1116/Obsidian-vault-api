export type ConfigSyncStatus = "added" | "updated" | "unchanged";

export interface ConfigSyncResult {
  status: ConfigSyncStatus;
  content: string;
}

const desiredServer = (bridgePath: string, port: number, apiKey: string) => ({
  command: "node",
  args: [bridgePath, String(port)],
  env: { VAULT_API_KEY: apiKey },
});

export function upsertJsonMcpServer(
  raw: string | undefined,
  bridgePath: string,
  port: number,
  apiKey: string,
): ConfigSyncResult {
  let config: Record<string, unknown> = {};
  if (raw?.trim()) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("the config root must be a JSON object");
    config = parsed as Record<string, unknown>;
  }

  const servers = config.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers)))
    throw new Error("mcpServers must be a JSON object");

  const mcpServers = (servers ?? {}) as Record<string, unknown>;
  const desired = desiredServer(bridgePath, port, apiKey);
  const existing = mcpServers.obsidian;
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    return { status: "unchanged", content: raw ?? "" };
  }

  mcpServers.obsidian = desired;
  config.mcpServers = mcpServers;
  return {
    status: existing ? "updated" : "added",
    content: JSON.stringify(config, null, 2) + "\n",
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexServerBlock(bridgePath: string, port: number, apiKey: string): string[] {
  const args = [bridgePath, String(port)].map(tomlString).join(", ");
  return [
    "[mcp_servers.obsidian]",
    'command = "node"',
    `args = [${args}]`,
    `env = { VAULT_API_KEY = ${tomlString(apiKey)} }`,
  ];
}

export function upsertCodexMcpServer(
  raw: string | undefined,
  bridgePath: string,
  port: number,
  apiKey: string,
): ConfigSyncResult {
  const original = raw ?? "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const desiredLines = codexServerBlock(bridgePath, port, apiKey);
  const sectionStart = lines.findIndex(line => line.trim() === "[mcp_servers.obsidian]");

  if (sectionStart >= 0) {
    let sectionEnd = sectionStart + 1;
    while (sectionEnd < lines.length && !lines[sectionEnd].trim().startsWith("[")) sectionEnd++;
    const currentLines = lines.slice(sectionStart, sectionEnd);
    let contentEnd = currentLines.length;
    while (contentEnd > 0 && currentLines[contentEnd - 1] === "") contentEnd--;
    if (currentLines.slice(0, contentEnd).join("\n") === desiredLines.join("\n"))
      return { status: "unchanged", content: original };
    const trailingBlankLines = currentLines.slice(contentEnd);
    lines.splice(sectionStart, sectionEnd - sectionStart, ...desiredLines, ...trailingBlankLines);
    return { status: "updated", content: lines.join(newline) };
  }

  const trimmed = original.trimEnd();
  const prefix = trimmed ? trimmed + newline + newline : "";
  return {
    status: "added",
    content: prefix + desiredLines.join(newline) + newline,
  };
}
