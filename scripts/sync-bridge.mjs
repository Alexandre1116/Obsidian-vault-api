#!/usr/bin/env node
// Embeds bridge.js as a string constant so main.js can write it to disk at
// runtime. BRAT only downloads manifest.json/main.js/styles.css from a
// release, so bridge.js must be self-hosted inside the bundle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, "bridge.js"), "utf8");
const out =
  `// Auto-generated from bridge.js by scripts/sync-bridge.mjs — do not edit directly.\n` +
  `export const BRIDGE_JS_SOURCE = ${JSON.stringify(source)};\n`;

fs.writeFileSync(path.join(root, "src", "bridge-source.ts"), out);
console.log("Synced bridge.js -> src/bridge-source.ts");
