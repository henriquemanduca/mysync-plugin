# MySync

MySync is an Obsidian plugin for syncing vault files through your own CouchDB
server.

It keeps a local PouchDB index of files in your vault, then lets you push that
local state to CouchDB or pull remote state back into Obsidian. It is intended
for users who want to run their own sync backend instead of relying on a hosted
sync provider.

> [!WARNING]
> MySync is currently beta software. Back up your vault before using it with
> important notes. Pulling from CouchDB can restore, overwrite, or delete local
> files based on the remote database state.

## Features

- Sync the full vault or a custom folder inside the vault.
- Track Markdown files, common image formats, PDFs, and other vault files.
- Push local vault changes to a CouchDB database.
- Pull remote CouchDB changes back into the vault.
- Test the remote CouchDB connection from Obsidian.
- Show sync progress and last push time in the Obsidian status bar.
- Optionally run a sync when Obsidian loads the plugin.

## Requirements

- Obsidian `1.12.7` or newer.
- A CouchDB database that already exists.
- A CouchDB user with access to that database.
- Node.js `22.22.0` or newer for development builds.

MySync does not create the remote CouchDB database for you. Create the database
first, then configure its URL, database name, username, and password in the
plugin settings.

## Installation

### Manual Installation From A Release

Download the release files and place them in your vault plugin folder:

```text
VaultFolder/.obsidian/plugins/mysync/
```

The folder must contain:

```text
main.js
manifest.json
styles.css
```

Reload Obsidian, open **Settings -> Community plugins**, and enable **MySync**.

### Development Installation

Clone this repository into your vault plugin folder:

```text
VaultFolder/.obsidian/plugins/mysync
```

Install dependencies and start the development build:

```sh
npm install
npm run dev
```

`npm run dev` watches `src/main.ts` and emits plugin files into `dist/`.
Reload Obsidian after starting the build, then enable the plugin from community
plugin settings.

## Configuration

Open **Settings -> MySync** in Obsidian.

### Local Configuration

- **Local vault ID**: automatically generated identifier for this vault's local
  PouchDB database.
- **Folder source**: choose whether to sync the vault root or a custom folder.
- **Custom sync folder**: folder path inside the vault when custom mode is
  selected.
- **Sync on startup**: run a local sync when Obsidian loads the plugin.
- **Last sync now**, **Last push to CouchDB**, and **Last pull from CouchDB**:
  read-only timestamps for successful operations.

### Remote Database

- **CouchDB URL**: base URL for your CouchDB server, for example
  `https://couchdb.example.com`.
- **CouchDB database**: database name used for remote sync, defaulting to
  `mysync`.
- **CouchDB username**: username for CouchDB basic authentication.
- **CouchDB password**: password for CouchDB basic authentication.

Use HTTPS for remote servers whenever possible. A dedicated CouchDB user with
access only to the MySync database is recommended.

## CouchDB Setup Helper

This repository includes `.env.sample` and `setup_couchdb.sh` as optional
helpers for preparing a CouchDB user and database security settings.

Copy `.env.sample` to `.env`, adjust the values, make sure the database already
exists, then run:

```sh
./setup_couchdb.sh
```

The script uses an admin account to create a plugin user and assign a role to
the configured database. Review the script before running it against a real
server.

## Usage

MySync adds these command palette commands:

- **Sync now**: scan the configured local folder and update the local PouchDB
  index.
- **Push to remote**: sync local files into the local PouchDB index, then push
  changes to CouchDB.
- **Pull from remote**: pull CouchDB changes into the local PouchDB index, then
  restore or delete vault files based on the remote state.
- **Test remote connection**: verify that the configured CouchDB database is
  reachable.

The ribbon icon runs **Push to remote**.

The status bar shows queued local changes, sync progress, push or pull progress,
operation results, and errors. When idle, it shows the last successful push
time when available.

## Safety Notes And Limitations

- Back up your vault before first use and before testing pull behavior.
- Remote pull can overwrite existing local files when the remote record differs.
- Remote deletion handling avoids deleting locally changed files when a conflict
  is detected, but you should still review important files after sync.
- CouchDB hosting, backups, HTTPS, user management, and access control are your
  responsibility.
- Credentials are stored in Obsidian plugin data. Do not commit plugin data,
  `.env`, vault content, or secrets.
- MySync does not currently provide end-to-end encryption.
- No automated test framework is configured yet.

## Development

Install dependencies:

```sh
npm install
```

Run the development watcher:

```sh
npm run dev
```

Create a production build:

```sh
npm run build
```

`npm run build` runs TypeScript checks and produces the bundled plugin files in
`dist/`.

To bump the plugin version, use:

```sh
npm version patch
```

You can also use `minor` or `major`. The version hook updates
`manifest.json` and `versions.json`.

## License

MIT. See [LICENSE](LICENSE).
