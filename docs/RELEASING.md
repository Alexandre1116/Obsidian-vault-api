# Release guide

Vault API is distributed as an Obsidian plugin through GitHub Releases. BRAT installs the release assets, not arbitrary commits from the `main` branch.

## Release contract

Every release must have:

- the same `x.y.z` version in `manifest.json`, `package.json`, and the root package entry in `package-lock.json`;
- a matching `versions.json` entry for the plugin version and `minAppVersion`;
- a `vX.Y.Z` Git tag and GitHub release name;
- non-empty `main.js`, `manifest.json`, and `styles.css` assets.

The bridge is embedded in `main.js`. Do not require `bridge.js` as a release asset.

## Prepare the release

1. Start from an up-to-date `main` branch with a clean working tree.
2. Choose the next SemVer version. Use a minor version for a new client integration and a patch version for a fix.
3. Update the version in `manifest.json`, `package.json`, `package-lock.json`, `versions.json`, and both runtime version values in `src/mcp-server.ts`.
4. Update the badge, release summary, and top changelog entry in `README.md`.
5. Update [`docs/API.md`](API.md) when a tool, endpoint, setting, limit, or response changes.
6. Run the full validation:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   git diff --check
   ```

7. Confirm the release metadata and assets locally:

   ```bash
   node -p "require('./manifest.json').version"
   node -p "require('./package.json').version"
   node -p "require('./package-lock.json').packages[''].version"
   git ls-files main.js manifest.json styles.css
   ```

8. Review the changelog and diff, then commit the release:

   ```bash
   git add README.md RELATED_PROJECTS.md docs package.json package-lock.json manifest.json versions.json src/mcp-server.ts main.js
   git commit -m "Release vX.Y.Z"
   ```

## Publish the release

Create and push the matching annotated tag:

```bash
git tag -a vX.Y.Z -m "Vault API vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

The `Release` workflow then checks the tag and versions, installs dependencies, runs typecheck, tests, and build, creates the GitHub release if needed, and uploads the three plugin assets.

The workflow can also be started from **Actions -> Release -> Run workflow** with an existing tag when an asset upload needs repair. It checks out the dispatched commit and uploads the rebuilt assets to that tag.

## Verify the published release

After the workflow completes, check the release page:

- The tag, release name, and asset `manifest.json` all show the same version.
- `main.js`, `manifest.json`, and `styles.css` are attached.
- The release is marked pre-release only when it is intentionally a beta.
- BRAT can install the repository with an empty version field.
- An existing BRAT installation finds the new version after **BRAT -> Check for updates**.
- The plugin starts in Obsidian and reports its MCP port.
- The Claude, ChatGPT app / Codex, and Google Antigravity connect buttons write their expected config formats.

## Rollback

For a rollback, select a known-good release version in BRAT. Do not retag an existing version. If an asset is broken, publish a new patch version or rerun the workflow for the same tag after replacing the asset.
