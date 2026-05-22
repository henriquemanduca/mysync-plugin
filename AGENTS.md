# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript Obsidian plugin for syncing with MySync. Source code lives in `src/`, with the plugin entry point at `src/main.ts`, settings UI and persistence in `src/settings.ts`, local PouchDB type declarations in `src/pouchdb.d.ts`, sync orchestration and storage modules in `src/sync/`, and shared helpers in `src/utils/`.

Obsidian release metadata is stored in `manifest.json` and compatibility versions in `versions.json`. Build configuration lives in `esbuild.config.mjs` and `tsconfig.json`; package and release automation live in `package.json`, `package-lock.json`, and `version-bump.mjs`. Styles for the plugin belong in `styles.css`. `setup_couchdb.sh`, `.env.sample`, and the `Makefile` support local CouchDB setup and development workflows.

Generated files are not source: `dist/` contains the bundled plugin artifacts (`main.js`, `manifest.json`, `styles.css`) and local runtime data. Root-level `main.js` is ignored as a legacy/generated artifact if present. Dependencies are installed in `node_modules/` and should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install dependencies for Node.js 22.22 or newer.
- `npm run dev`: watch `src/main.ts` and emit `main.js` for local Obsidian testing.
- `npm run build`: run TypeScript checks and produce a production bundle.
- `npm version patch|minor|major`: update `package.json`, then run the configured version hook to sync `manifest.json` and `versions.json`.

For manual testing, place this repository under `VaultFolder/.obsidian/plugins/mysync`, run `npm run dev`, reload Obsidian, and enable the plugin.

## Coding Style & Naming Conventions

Use tabs for indentation in code and JSON, matching `.editorconfig`. Keep TypeScript strict and explicit where the compiler requires it. Prefer descriptive plugin-facing IDs such as `sync-now` and class names such as `MySyncPlugin`.

Use Obsidian APIs from the `obsidian` package instead of direct DOM or Electron access unless the feature requires it. Keep user-visible strings short and specific.

## Testing Guidelines

No automated test framework is configured yet. For now, use `npm run build` as the required verification step before committing. For behavior changes, also test inside Obsidian by enabling the plugin, opening settings, and running the “Sync now” command from the command palette.

If tests are added later, place them near the feature or in a dedicated `tests/` directory and document the command in `package.json`.

## Commit & Pull Request Guidelines

The current history uses concise, imperative commit messages, for example `Initial Obsidian plugin scaffold`. Continue that style: `Add sync settings`, `Implement token validation`.

Pull requests should include a short summary, testing notes, and any Obsidian UI changes. Link related issues when available. Include screenshots only for visible UI or settings changes.

## Security & Configuration Tips

Treat `apiToken` and future credentials as sensitive. Do not log tokens, commit local vault data, or store secrets outside Obsidian plugin data APIs.
