# Release and BRAT guide

This project is distributed as an Obsidian plugin through GitHub Releases. BRAT installs and updates the release assets; it does not install an arbitrary branch commit.

## Release contract

Every release must satisfy all of these rules:

- `manifest.json`, `package.json`, and the root `package` entry in `package-lock.json` use the same `x.y.z` version.
- The Git tag is `vX.Y.Z` and the GitHub release name is also `vX.Y.Z`.
- The release contains these assets:
  - `main.js`
  - `manifest.json`
  - `styles.css`
- `manifest.json` in the release has the same version as the tag.
- `versions.json` maps the plugin version to its minimum supported Obsidian version. It only needs a new entry when the compatibility history is being recorded or `minAppVersion` changes.

BRAT uses the release assets above. Runtime-only files such as `bridge.js` must not be required as release assets because the bridge is embedded into `main.js` during the build.

## Preparing a release

1. Merge the feature PR into `main`.
2. Choose the next SemVer version. Use a minor version for new client integrations and a patch version for fixes.
3. Update all version fields and the `README.md` changelog.
4. Add or update the entry in `versions.json` if the compatibility mapping changed.
5. Run the full local validation:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   git diff --check
   ```

6. Commit the version bump on `main`.
7. Create and push the matching tag:

   ```bash
   git tag -a vX.Y.Z -m "Vault API vX.Y.Z"
   git push origin vX.Y.Z
   ```

The GitHub Actions `Release` workflow checks the version, runs typecheck/tests/build, creates the GitHub release if needed, and uploads the three BRAT assets. It can be re-run from **Actions -> Release -> Run workflow** by providing the existing tag if an upload needs to be repaired.

Do not manually publish a release without those assets. A release that has only a tag or release notes is not installable by BRAT.

## BRAT verification checklist

After the workflow finishes, verify the release page before announcing the update:

- The tag, release name, and asset `manifest.json` all show the same version.
- `main.js`, `manifest.json`, and `styles.css` are attached to the release.
- The release is marked pre-release only when it is intentionally a beta.
- A clean Obsidian vault can install the repository with BRAT when the version field is empty.
- An existing BRAT installation sees the new version after **BRAT -> Check for updates**.
- The plugin loads and the console reports the MCP server port.
- The Claude CLI/Desktop, ChatGPT app / Codex, and Google Antigravity connection buttons write the expected config format.

## Rollback

For a rollback, select the exact known-good release version in BRAT. Do not retag an existing version. If a release has a broken asset, create a new patch version or re-run the workflow for that tag after replacing the assets.

## Local release inspection

Before pushing a tag, these commands should report the expected version and files:

```bash
node -p "require('./manifest.json').version"
node -p "require('./package.json').version"
node -p "require('./package-lock.json').packages[''].version"
git ls-files main.js manifest.json styles.css
```
