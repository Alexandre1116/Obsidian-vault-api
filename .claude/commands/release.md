---
description: Release checklist — bump the version across every place it's hardcoded, update the changelog, verify, and stop before pushing.
argument-hint: [new-version] [min-app-version]
---

Bump the plugin to version **$1** (minAppVersion: ${2:-1.0.0}). Do not skip any step, and do not push or tag — this command stops at a reviewed local commit.

## Version is duplicated in 5 files / 7 locations — update all of them

1. `manifest.json` → `"version"` field.
2. `package.json` → `"version"` field.
3. `versions.json` → add a new key `"$1"` mapping to the minAppVersion (this file is an append-only map from version → minAppVersion, don't remove old entries).
4. `src/mcp-server.ts`:
   - Line inside `createMcpInstance()`: `{ name: "obsidian-vault", version: "..." }` — **not** read from `package.json`, must be edited by hand.
   - Line inside the `/health` handler: `const body = { status: "ok", version: "..." }` — same, hardcoded separately.
5. `README.md`:
   - The version badge at the top (`img.shields.io/badge/version-...`).
   - The blockquote summary line right below it (`> **v...** — <one-line summary>`).
   - A new `### $1` section at the top of the Changelog, following the existing format (bold **New:**/**Fix:**/**Security:**/**Perf:** bullet prefixes). Write the summary from the actual diff since the last version tag — don't guess.

Grep for the *previous* version string across the repo after editing to confirm nothing was missed:
```
grep -rn "<previous-version>" --include="*.ts" --include="*.json" --include="*.md" . | grep -v node_modules | grep -v package-lock.json
```
Any remaining hit (other than historical changelog entries or code comments referencing an old version by name, e.g. "the 1.1.2 bridge.js relocation") is a miss — fix it.

## Verify before committing

6. Run `npm run typecheck` — must pass.
7. Run `npm run test` — must pass.
8. Run `npm run build` — confirm `main.js` regenerates without error.

## Stop and review

9. Show `git diff --stat` and the full changelog entry you wrote. Ask for explicit confirmation before running `git add`/`git commit`.
10. After confirmation, commit with message `Release vX.X.X` (no tag, no push, no GitHub release draft — those stay manual).
