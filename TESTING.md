# Testing

MySync uses Vitest for unit tests. Tests run in Node.js and replace the Obsidian
runtime module with the small test double in `tests/mocks/obsidian.ts`.

## Commands

```sh
npm test
npm run test:watch
npm run test:coverage
npm run test:typecheck
npm run check
```

`npm run check` is the complete local verification command. It builds the
production bundle, type-checks test code, and runs the unit test suite once.

## Current coverage

The initial suite prioritizes code that can alter vault or Obsidian
configuration data:

- path scope and record ID rules;
- text and binary content hashing;
- top-level configuration file discovery;
- configuration record creation;
- synchronization of new, unchanged, and removed configuration files;
- restoration through the Obsidian adapter;
- rejection of nested plugin configuration destinations;
- logging redaction and PouchDB error guards.

UI rendering remains covered by manual Obsidian testing. Unit tests should not
try to reproduce the complete Obsidian DOM runtime.

## Incremental roadmap

### 1. Test foundation — complete

- Vitest runner and V8 coverage.
- Type-checking configuration for tests.
- Minimal Obsidian API test double.
- Utility and vault-file tests.

### 2. Configuration synchronization — complete

- Public `SyncService.syncNow()` scenarios.
- Configuration deletion revisions.
- Public pull restoration and destination protection.
- Error status and notice behavior.

### 3. Local stores

- File record create, update, unchanged, and delete behavior.
- Local and remote baseline handling.
- Conflict store lifecycle and status filtering.
- Reset and close serialization.

These tests should use an isolated PouchDB-compatible test database and destroy
it after every test.

### 4. Conflict and replication policies

- Edit/edit and edit/delete classification.
- Keep local, keep remote, keep both, and delete strategies.
- Pending-push retry behavior.
- Replication checkpoint and document-filter behavior.
- Remote request authentication and error conversion.

Prefer extracting pure policy functions from `SyncService` before expanding
this layer. This keeps the tests focused on inputs and outcomes instead of
private implementation details.

### 5. Obsidian integration smoke tests

- Load the built plugin in a disposable vault.
- Open and save settings.
- Run sync, push, and pull commands.
- Verify configuration restoration after an Obsidian reload.

These checks require a real Obsidian environment and complement, rather than
replace, the unit suite.

## Coverage policy

Coverage is reported but not gated initially. Add thresholds after the store
and conflict-policy increments are covered. A useful first gate is 70% for
statements and branches in modules included by the unit suite, while keeping
destructive sync paths covered by explicit scenario tests.
