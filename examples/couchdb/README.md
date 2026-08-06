# CouchDB - Docker Compose Example

Minimal example to run CouchDB locally for testing the MySync plugin.

## Contents

- `docker-compose.yml` - runs `couchdb:3.5` in single-node mode with a persistent volume and healthcheck
- `.env.example` - example variables (admin, plugin user, port, database)
- `local.ini.example` - enables single-node mode and CORS for local testing; copy it to `local.ini`

## Usage

```sh
cd examples/couchdb

# 1. Configure variables
cp .env.example .env
# edit .env to change passwords or port if needed

# 2. Create the local CouchDB configuration used by Docker Compose
cp local.ini.example local.ini

# 3. Start the service
docker compose up -d

# 4. Verify
curl http://127.0.0.1:5984/_up
# or with auth: curl -u admin:admin_password http://127.0.0.1:5984/_all_dbs

# 5. Create the database (MySync does not create it automatically)
curl -u admin:admin_password -X PUT http://127.0.0.1:5984/mysync

# 6. (Optional) Create the plugin user and permissions via the root script
# From the repository root, with .env pointing to http://127.0.0.1:5984:
#   cp examples/couchdb/.env ../../.env  # or adjust manually
#   ./setup_couchdb.sh
```

Then configure the plugin in Obsidian under **Settings -> MySync**:

- CouchDB URL: `http://127.0.0.1:5984`
- Database: `mysync`
- Username/Password: `mysync_user` / `mysync_password` (or the admin user for quick tests)

## Teardown / Cleanup

```sh
docker compose down        # stop and remove the container
docker compose down -v     # also remove the mysync-couchdb-data volume
docker compose logs -f couchdb
```
