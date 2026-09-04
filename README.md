# MySync

MySync is an open-source Obsidian plugin designed for seamless, bidirectional synchronization of your vault files through your own self-hosted **Nextcloud** or **Apache CouchDB** server.

It gives you full ownership and privacy over your data, combining a fast local PouchDB file index with robust remote synchronization backends.

> [!CAUTION]
> ### ⚠️ Vault Backup & Data Responsibility Disclaimer
> **While MySync is stable, actively maintained, and built with safety mechanisms (such as conflict detection, conditional writes, and bulk deletion safeguards), the ultimate responsibility for your files and data integrity belongs to you.**
>
> Remote synchronization inherently involves reading, updating, restoring, and deleting local and remote files. Always create and maintain regular, independent backups of your Obsidian vault (such as automated snapshots, Git, or external backups) before configuring or running synchronization.

---

## Remote Synchronization Backends

MySync supports two self-hosted backends. You can choose whichever best fits your infrastructure in the plugin settings.

### 1. Nextcloud (Recommended)
**What is Nextcloud?**  
[Nextcloud](https://nextcloud.com/) is a leading open-source, self-hosted productivity and cloud storage platform. It stores files natively on your server's filesystem, making them easily accessible through Nextcloud's web interface, desktop sync clients, and mobile apps.

**How MySync works with Nextcloud:**
- **Native File Storage:** Your notes and attachments are stored directly as standard files and folders inside your chosen Nextcloud directory (e.g., `/Notes`).
- **Standard WebDAV Protocol:** Synchronization operates over standard HTTP/HTTPS WebDAV (`remote.php/dav/files/{user}/...`), requiring no custom Nextcloud apps or server modifications.
- **Optimistic Concurrency Control:** MySync uses WebDAV conditional headers (`ETag`, `If-Match`, and `If-None-Match`) to ensure that remote edits made while you were offline or from another device are never silently overwritten.
- **Safe Merging & Deletion Guardrails:** First-time pulls perform conservative merges, and bulk deletion thresholds prompt for explicit user confirmation before removing files locally.

### 2. Apache CouchDB
**What is CouchDB?**  
[Apache CouchDB](https://couchdb.apache.org/) is a battle-tested, open-source document-oriented NoSQL database. It is renowned for its Multi-Version Concurrency Control (MVCC) and revision trees (`_rev`), making it an industry benchmark for offline-first replication.

**How MySync works with CouchDB:**
- **Document & Attachment Indexing:** Files and configurations are serialized into JSON documents with binary attachments.
- **PouchDB Synchronization:** MySync leverages local in-browser PouchDB instances inside Obsidian that replicate directly with your remote CouchDB server using the standard CouchDB replication protocol.
- **Revision History:** Conflicted changes are tracked natively through CouchDB revision branches, allowing fine-grained resolution between competing file versions.

---

## Features

- **Choice of Backend:** Seamlessly sync to either **Nextcloud** (via WebDAV) or **Apache CouchDB** (via replication).
- **Flexible Scope:** Sync your entire vault or restrict sync to a designated subfolder.
- **Obsidian Configuration Sync:** Optionally synchronize top-level Obsidian configuration files (`app.json`, `hotkeys.json`, `workspace.json`), while safely excluding credentials and plugin caches.
- **Supported File Types:** Full support for Markdown (`.md`), PDFs (`.pdf`), and standard image formats (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.bmp`).
- **Conflict Management:** Built-in interactive conflict resolver modal to inspect and resolve conflicting edits side-by-side (keep local, keep remote, or keep both).
- **Deletion Safeguards:** Interactive confirmation prompts before applying significant remote deletions.
- **Empty Folder Cleanup:** Dedicated utility command to safely prune empty folder hierarchies.
- **Status Bar & UI Indicators:** Real-time visibility into sync status, pending uploads, conflict counts, and last sync timestamps.

---

## Configuration Manual

Open Obsidian **Settings -> MySync** to access all plugin options:

### Local Configuration
- **Folder source:** Choose between syncing the entire vault (**Use Obsidian vault root**) or a specific subfolder (**Set a custom folder**).
- **Custom sync folder:** When custom mode is selected, specify the relative vault path to sync (e.g., `Projects/MySync`).
- **Sync Obsidian configuration:** Toggle whether to synchronize top-level files in your `.obsidian/` folder (`app.json`, `hotkeys.json`, `workspace.json`). Plugin binaries and credentials are automatically excluded.
- **Obsidian configuration folder:** Displays the active configuration folder path reported by Obsidian (read-only).
- **Log level:** Sets the logging verbosity written to `mysync.log` and the developer console (`Debug`, `Log`, `Info`, `Warnings`, `Errors`, `Off`).
- **Timestamps:** Displays read-only execution times for **Last sync now**, **Last push to remote**, and **Last pull from remote**.
- **Local file & conflict database IDs:** Read-only identifiers for the local PouchDB databases scoped to this vault.

### Local Data Management
- **Reset local databases:** Destructive utility button that clears the local PouchDB index, revision trees, conflict history, and sync checkpoints without modifying or deleting your actual vault files or remote data. Use this if the local index becomes corrupt or out of sync.
- **Last local database reset:** Displays the timestamp of the most recent local database reset.

### Remote Backend Configuration

#### Configuring Nextcloud
Select **Nextcloud** under *Remote synchronization backend*:
- **Nextcloud URL:** The base URL of your Nextcloud instance (e.g., `https://cloud.example.com`).
- **Nextcloud username:** Your Nextcloud account username.
- **Nextcloud App Password:** A dedicated app password created in Nextcloud (**Settings -> Security -> Devices & credentials**). *Never use your primary account password.*
- **Nextcloud Remote Path:** The folder path in Nextcloud where notes should be stored (e.g., `/Notes` or `/Obsidian`). The directory must already exist on Nextcloud.

#### Configuring CouchDB
Select **CouchDB** under *Remote synchronization backend*:
- **CouchDB URL:** The base URL of your CouchDB instance (e.g., `https://couchdb.example.com` or `http://localhost:5984`).
- **CouchDB database:** The target database name (defaults to `mysync`). The database must already exist.
- **CouchDB username:** CouchDB authentication username for basic auth.
- **CouchDB password:** CouchDB authentication password for basic auth.

---

## Shortcuts, Commands & UI Controls

MySync integrates directly into Obsidian's Command Palette, Ribbon, and Status Bar.

### Command Palette (`Ctrl+P` / `Cmd+P`)
All commands can be bound to custom keyboard shortcuts via **Obsidian Settings -> Hotkeys**:

| Command | Description |
| :--- | :--- |
| **MySync: Push to remote** | Scans local changes and pushes all safe modifications to the remote backend. |
| **MySync: Push pending files to remote** | Pushes only queued and pending file changes to the remote backend. |
| **MySync: Pull from remote** | Fetches remote changes, reconciles with the local baseline, and safely applies non-conflicting updates. |
| **MySync: Sync now** | Performs an immediate local scan and updates the internal PouchDB database index. |
| **MySync: Resolve sync conflicts** | Opens the interactive conflict resolution modal to view and resolve any conflicting files. |
| **MySync: Clean empty folders** | Scans the vault for empty folders and allows selective or batch removal. |
| **MySync: Test remote connection** | Validates credentials and checks connectivity to the configured remote backend. |

### Ribbon Icons (Left Sidebar)
- **Database Backup Icon (`database-backup`):** Triggers **Sync local to remote** (pushes local changes to remote backend).
- **File Upload Icon (`file-up`):** Triggers **Push pending files to remote**.

### Status Bar (Bottom Right)
- **Status Information:** Displays current state (idle, syncing, pushing, pulling, pending changes count, or error messages).
- **Last Sync Time:** Shows timestamp of the last successful push when idle.
- **Interactive Conflict Alert:** If conflicts exist, the status bar displays the active conflict count. Clicking anywhere on the MySync status bar item immediately opens the **Resolve sync conflicts** modal.

---

## Conflict Handling & Synchronization Rules

1. **Simultaneous Edits:** If a file was modified both locally and remotely since the last sync baseline, MySync flags it as a conflict. It will never overwrite your local changes silently.
2. **Conflict Resolution Modal:** You can inspect conflicts and choose to:
   - **Keep Local:** Overwrites the remote file with your local version.
   - **Keep Remote:** Replaces your local file with the remote version.
   - **Keep Both:** Retains both versions, renaming the remote copy with a conflict suffix.
3. **First-Time Sync:**
   - On an existing remote backend, always run **Pull from remote** first to establish an accurate baseline before pushing.
   - Pushing to a non-empty remote without a baseline is prevented to protect existing remote content.

---

## Safety Notes And Limitations

- **Vault Backups:** Always maintain external backups of your notes before syncing.
- **File Types:** Only `.md`, `.pdf`, supported images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.bmp`), and enabled top-level configuration files are synced. Other files are skipped.
- **Configuration Scoping:** Only top-level configuration files (`app.json`, `hotkeys.json`, `workspace.json`) in your configuration folder are synced. Third-party plugin binaries, themes, and secret files are excluded.
- **HTTPS Recommended:** Always use HTTPS with valid certificates when connecting to your remote server across networks.
- **End-to-End Encryption:** MySync does not provide E2EE. Ensure your backend server is properly secured and encrypted at rest if required.

---

## CouchDB Setup Helper

This repository includes `.env.sample` and `setup_couchdb.sh` to assist with CouchDB initialization:

1. Copy `.env.sample` to `.env` and adjust the variables.
2. Ensure CouchDB is running and create your database.
3. Run the helper script:
   ```sh
   ./setup_couchdb.sh
   ```

A Docker Compose reference setup is also available in [`examples/couchdb/`](examples/couchdb/).

---

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

---

## Development

Clone this repository into your vault plugin directory:

```text
VaultFolder/.obsidian/plugins/mysync
```

Install dependencies:

```sh
npm install
```

Development watch mode:

```sh
npm run dev
```

Build production bundle:

```sh
npm run build
```

Run test suite:

```sh
npm test
```

Deploy build to configured vaults:

```sh
make deploy
```

---

## License

MIT. See [LICENSE](LICENSE).
