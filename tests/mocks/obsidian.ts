// Minimal stand-in for the Obsidian runtime, which only exists inside the
// desktop app. vitest.config.ts aliases "obsidian" here. The YAML parser
// understands just enough for the tests; real parsing comes from Obsidian.
export class TFile {
  constructor(public path: string) {}
}

export function parseYaml(raw: string): unknown {
  if (raw.includes("bad: [")) throw new Error("unexpected end of flow sequence");
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { (out[listKey] as unknown[]).push(item[1]); continue; }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    listKey = kv[2] === "" ? kv[1] : null;
    out[kv[1]] = kv[2] === "" ? [] : kv[2];
  }
  return out;
}
