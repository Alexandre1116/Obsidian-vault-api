---
description: Prepare a version bump, changelog, validation, and reviewed local release commit.
arguments: <new-version> [minimum-obsidian-version]
---

# Prepare a release

Use `<new-version>` as an `x.y.z` version. Use `1.0.0` as the minimum Obsidian version unless the second argument changes it. Do not push, tag, or publish without explicit approval.

## Update versions and documentation

1. Set `manifest.json` `version` and verify `minAppVersion`.
2. Set the same version in `package.json` and the root package entry in `package-lock.json`.
3. Add the version mapping to `versions.json` when needed. Keep all historical entries.
4. Update both hardcoded version values in `src/mcp-server.ts`, the MCP server identity and `/health` response.
5. Update the README badge, release summary, and top changelog entry using the actual diff since the previous release.

Search the repository for the previous version. Historical changelog entries may remain. Current metadata and runtime values must not.

## Validate

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

Confirm that `main.js`, `manifest.json`, and `styles.css` exist and are non-empty. Show the diff summary and new changelog entry before committing.

After approval, create a local commit named `Release vX.Y.Z`. Stop before pushing, tagging, or creating a GitHub Release.
