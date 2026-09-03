# MySync

MySync is an Obsidian plugin for syncing vault files through your own CouchDB
or Nextcloud server.

It keeps a local PouchDB index of files in your vault, then lets you push that
local state to the selected backend or pull remote state back into Obsidian. It is intended
for users who want to run their own sync backend instead of relying on a hosted
sync provider.

> [!WARNING]
> Back up your vault before using it with important notes.
> Pulling from a remote backend can restore, overwrite, or delete local
> files based on the remote database state.

## Features

- Sync the full vault or a custom folder inside the vault.
- Sync top-level Obsidian configuration files using the vault's configured
  configuration directory.
- Track Markdown files, PDFs, and common image formats.
- Push and pull through CouchDB or Nextcloud WebDAV.
- Detect simultaneous edits and edit/delete conflicts without overwriting either side.
- Use conditional Nextcloud writes (`ETag`, `If-Match`, and `If-None-Match`) to prevent lost updates.
- Test the configured remote connection from Obsidian.
- Show sync progress and last push time in the Obsidian status bar.
- Optionally run a sync when Obsidian loads the plugin.

## Requirements

- Obsidian `1.12.7` or newer.
- A CouchDB database and user, or an existing Nextcloud WebDAV folder and app password.
- Node.js `22.22.0` or newer for development builds.

MySync does not create the remote CouchDB database or the configured Nextcloud
root folder. Create the selected target first and grant the configured account
read/write access.

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

## Configuration

Open **Settings -> MySync** in Obsidian.

### Local Configuration

- **Local vault ID**: automatically generated identifier for this vault's local
  PouchDB database.
- **Folder source**: choose whether to sync the vault root or a custom folder.
- **Custom sync folder**: folder path inside the vault when custom mode is
  selected.
- **Obsidian configuration folder**: read-only path reported by Obsidian.
  Top-level files in this folder are included even though hidden configuration
  files are not exposed by the regular Vault file tree.
- **Last sync now**, **Last push to remote**, and **Last pull from remote**:
  read-only timestamps for successful operations.
- **Last local database reset**: read-only timestamp for the most recent
  successful reset of both local MySync databases.
- **Reset local databases**: delete the local file index and conflict history
  without changing vault files or the remote CouchDB database.

### Remote Database

- **Remote synchronization backend**: choose CouchDB or Nextcloud.

- **CouchDB URL**: base URL for your CouchDB server, for example
  `https://couchdb.example.com`.
- **CouchDB database**: database name used for remote sync, defaulting to
  `mysync`.
- **CouchDB username**: username for CouchDB basic authentication.
- **CouchDB password**: password for CouchDB basic authentication.

Use HTTPS for remote servers whenever possible. A dedicated CouchDB user with
access only to the MySync database is recommended.

For Nextcloud, configure the server URL, username, an app password, and an
existing remote path. The password is used only for authentication and is not
included in the per-target local sync snapshot.

## Usage

MySync adds these command palette commands:

- **Sync now**: scan the configured local folder and update the local PouchDB
  index.
- **Push to remote**: sync local files into the local PouchDB index, then push
  safe changes to the selected backend.
- **Pull from remote**: reconcile the local vault, the previous local snapshot,
  and the selected remote backend, then apply non-conflicting changes.
- **Resolve sync conflicts**: open the conflict pop-up and choose whether to keep
  the local version, the remote version, or both versions.
- **Test remote connection**: verify that the configured CouchDB database is
  reachable.

The **Reset local databases** action is available in MySync settings. It removes
local file records, revision trees, conflicts, baselines, and replication
checkpoints, then recreates both databases with the same vault-specific names.
It does not delete or modify files in the vault and does not make requests that
change the remote CouchDB database.

After a reset, pull before pushing when the configured remote database already
contains MySync records. The regular push safety check blocks a full push to a
non-empty remote database until a new remote baseline has been established.

The first Nextcloud pull is a conservative merge: remote-only files are
downloaded, identical files establish a baseline, differing files become
conflicts, and local-only files are left for a later push. A first push is
allowed only when a complete WebDAV listing proves the remote folder is empty;
otherwise run pull first. Users upgrading from an older Nextcloud push-only
version must also run pull once to establish this snapshot.

The ribbon icon runs **Push to remote**.

The status bar shows queued local changes, sync progress, push or pull progress,
operation results, and errors. When idle, it shows the last successful push
time when available.

## Safety Notes And Limitations

- Back up your vault before first use and before testing pull behavior.
- Nextcloud synchronization includes `.md`, `.pdf`, recognized image formats,
  and the enabled top-level Obsidian configuration files. Other remote files are
  ignored and counted as skipped.
- Remote pull can overwrite existing local files when the remote record differs.
- Remote pull can also restore or delete top-level Obsidian configuration
  files. Reload Obsidian after pulling configuration changes.
- Theme, snippet, and community-plugin subfolders are not copied. This prevents
  plugin bundles and plugin-owned credential files from being uploaded as
  Obsidian configuration.
- Remote deletion handling avoids deleting locally changed files when a conflict
  is detected, but you should still review important files after sync.
- A Nextcloud pull asks for confirmation before deleting at least 10 local files
  when they represent 25% or more of the previous snapshot. Cancelling leaves
  the vault, snapshot, and successful-pull timestamp unchanged.
- A missing folder, malformed or incomplete WebDAV listing, unsafe path, or
  missing file `ETag` aborts the pull and is never treated as an empty remote.
- Conflicted paths are excluded from automatic local sync and remote push until
  they are resolved. If a resolution cannot be pushed, reopen the conflict
  pop-up to retry it.
- Resetting the local databases permanently removes the local conflict history,
  revision trees, baselines, and replication checkpoints. Back up important
  data and review the confirmation before continuing.
- The local conflict database is created automatically and its name follows the
  local file database identifier for the current vault.
- CouchDB hosting, backups, HTTPS, user management, and access control are your
  responsibility.
- Credentials are stored in Obsidian plugin data. Do not commit plugin data,
  `.env`, vault content, or secrets.
- MySync does not currently provide end-to-end encryption.
- Self-signed TLS certificates and arbitrary file types are not supported.

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

For local development and testing, an example Docker Compose setup is available
at [`examples/couchdb/`](examples/couchdb/). It runs a single-node CouchDB
container with a persistent volume and health check. See
[`examples/couchdb/README.md`](examples/couchdb/README.md) for instructions.

## Development

Clone this repository into your vault plugin folder:

```text
VaultFolder/.obsidian/plugins/mysync
```

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

Run the unit tests:

```sh
npm test
```

Use `npm run test:watch` while developing, `npm run test:coverage` to generate
the coverage report, or `npm run check` to run the production build, test type
checks, and unit tests together. See [TESTING.md](TESTING.md) for the incremental
testing roadmap and mock boundaries.

For local Obsidian testing, reload Obsidian after starting the development
build, then enable the plugin from community plugin settings.

To bump the plugin version, use:

```sh
npm version patch
```

You can also use `minor` or `major`. The version hook updates
`manifest.json` and `versions.json`. Release tags are generated without a
`v` prefix so they match the manifest version.

## License

MIT. See [LICENSE](LICENSE).
