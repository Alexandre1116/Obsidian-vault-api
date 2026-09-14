---
paths:
  - "tests/**"
  - "scripts/**"
---

# Tests and generated files

## Obsidian runtime imports

The `obsidian` dependency supplies types during development. Obsidian injects the real runtime implementation when it loads the plugin. Vitest has no Obsidian runtime alias or mock.

Do not import `src/vault-tools.ts`, `src/mcp-server.ts`, or `src/main.ts` directly into unit tests unless the change also adds a deliberate runtime mock or integration harness.

`tests/vault-tools.test.ts` duplicates pure helpers such as extension sets, MIME lookup, resize thresholds, formatting, path validation, glob matching, and command allowlist logic. When source logic changes, update the test copy and keep behavior identical.

`tests/runtime-files.test.ts` can import `src/runtime-files.ts` because that module uses only Node.js APIs. Temporary directories created by tests must be removed in `afterEach`, including after a failed assertion.

Write test names as observable behavior. Keep one `describe` block per function or cohesive unit.

## Bridge generation

`bridge.js` is the source of truth. `scripts/sync-bridge.mjs` reads it and generates `src/bridge-source.ts` as one exported string constant:

```ts
export const BRIDGE_JS_SOURCE = "...";
```

`src/bridge-source.ts` is generated and ignored. Never edit or commit it. All npm build, test, and typecheck scripts run bridge synchronization first.

If the generator changes, preserve the exported constant name and exact bridge contents. Test generator logic in isolation instead of testing the generated file.

## Required verification

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

CI repeats the checks on Ubuntu, Windows, and macOS.
