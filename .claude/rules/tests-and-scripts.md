---
paths:
  - "tests/**"
  - "scripts/**"
---

# Conventions for `tests/` and `scripts/`

## `tests/vault-tools.test.ts` doesn't import `src/vault-tools.ts` or `src/mcp-server.ts`

This is intentional, not an oversight. Both source files `import { App, TFile } from "obsidian"`, and `obsidian` is a **types-only** package here (see `package.json` devDependencies) — the real implementation only exists inside the Obsidian desktop runtime. `vitest.config.ts` has no alias/mock for it, so importing either module directly from a test would throw at module-resolution time.

Instead, `tests/vault-tools.test.ts` re-declares the pure-logic helpers standalone: `IMAGE_EXTS`, `SVG_EXTS`, `BINARY_EXTS`, `maxDimForSize`, `mimeType`, `formatBytes`, `validatePath`, `globMatch`, `isCommandAllowed`.

**When you add or change one of these pure helpers in `src/vault-tools.ts` or `src/mcp-server.ts`:**
1. Copy the updated logic into `tests/vault-tools.test.ts` by hand — there is no automated sync for this (unlike `bridge.js` → `bridge-source.ts`, which does have `sync-bridge.mjs`).
2. Keep the duplicate byte-for-byte equivalent in behavior, not just similar — the tests are only meaningful if they test the real logic.
3. Add `describe`/`it` blocks following the existing style: one `describe` per function, `it` phrased as an observable behavior ("rejects path traversal (..)", not "test 4").

If a new helper depends on `App`/`TFile` and can't be made pure, don't try to test it here — it needs either a real Obsidian test harness (none exists in this repo yet) or manual verification inside Obsidian.

## `scripts/sync-bridge.mjs`

Build-time codegen only — reads `bridge.js` (repo root, source of truth) and writes `src/bridge-source.ts` (generated, gitignored, never edited by hand). It runs as a prerequisite step in every npm script (`dev`, `build`, `typecheck`, `test`), not standalone.

If you modify `sync-bridge.mjs` itself:
- The output must stay a single `export const BRIDGE_JS_SOURCE = <JSON-stringified source>;` — `main.ts` imports this constant directly and writes it to disk verbatim at runtime, so any change to the output shape breaks the plugin, not just the build.
- Don't add test coverage for `bridge-source.ts` itself — it's generated output, not logic to verify. If `sync-bridge.mjs`'s own generation logic needs a test, test the script's function in isolation instead.
