# Session container

A headless DuckDB client that plays the same role the browser tab plays in
`frontend/src/sessionWs.ts` / `frontend/src/catalogWs.ts`, but as a
long-running Node process instead of a page open in someone's browser. It
connects to the Worker's `/session/ws` (and optionally `/catalog/ws`), runs
`query` and `transform_job` messages through `@duckdb/node-api`, and streams
results back — so MCP tools like `run_query` keep working even when nobody
has the app open.

The Session DO (`src/session/do.ts` in the repo root) doesn't distinguish
client types: whichever socket is connected for a user gets routed queries.
This container is a drop-in replacement (or 24/7 companion) for that browser
tab.

## Design notes

**Persistent, not hibernating — but can be started and stopped from the
outside.** Once running, this process holds one WebSocket open for its
entire lifetime, pinging every 25s (the Session DO marks a socket stale
after 3 missed pings — `src/session/do.ts`), and does *not* internally try
to scale to zero or reconnect lazily on demand — it has no idea whether
anything stopped/started it. That's still a deliberate design choice for
*this process's own code*: on a plain VPS/VM/docker-compose deployment
(`deploy/README.md`), it simply needs to be kept running 24/7, since
nothing fronts it to start it back up, and a query arriving while it's down
fails immediately with `no_session`.

**On Cloudflare Containers specifically, this process doesn't manage its
own lifecycle at all** — `src/session/do.ts`'s `SessionDO` does, externally,
via the Durable Object Container API (`ctx.container`): it starts a
container on demand when a query/job arrives and nothing is already
connected, and stops it after an idle period. This container's own code is
identical either way — it just connects and stays connected for as long as
the process lives, same as the plain-VPS case — the only difference is
*how long that happens to be* and *who decided to start it*. See
`deploy/README.md`'s "Cloudflare Containers — wake-on-query" section for
how that orchestration works, and note that it passes `AUTH_MODE=token`/
`API_TOKEN`/`WORKER_URL` to each container instance automatically (a
dedicated, self-provisioned, revocable token) — nothing to configure by
hand for that path specifically.

**Auth: three supported modes**, all already supported by the existing Worker
with no server-side changes:

- **`AUTH_MODE=token`** (recommended) — an API token you create yourself:
  the `dshack` CLI (`dshack auth create-token <name>`), the Workbench UI
  (Settings → API Tokens → New token), or `POST /api/tokens` directly — all
  mint the same kind of credential. It's a real, revocable,
  optionally-expiring token scoped to your own user — no shared secret, no
  interactive OAuth dance, no rotating file to persist. The Worker
  recognizes the `dsk_` prefix and checks it against the `api_tokens` table
  directly (`src/auth/middleware.ts`), independent of
  `ENABLE_DEV_AUTH`/`ENABLE_OAUTH`. Revoke it from the same place the moment
  you decommission a container. Note it cannot itself mint further tokens
  (`POST /api/tokens` returns 403 for an api-token-authenticated caller).
- **`AUTH_MODE=dev-token`** (simplest, but a shared secret) — a static
  token matching the Worker's `ENABLE_DEV_AUTH` bypass
  (`src/auth/middleware.ts`). No expiry, no refresh logic. Give this
  container its own `DEV_TOKEN`/`DEV_USER_ID` secret pair on the Worker —
  don't reuse your local-dev or CI secret — since it's effectively a
  long-lived bearer credential for whatever `DEV_USER_ID` you configure, and
  unlike an API token it can't be revoked individually (only by rotating
  the Worker's `DEV_TOKEN` secret, which invalidates every client using it).
- **`AUTH_MODE=oauth-refresh`** — proper per-user OAuth via a full DCR +
  PKCE login, for cases where a personal access token isn't suitable (e.g.
  you want the container to act as a distinct Google identity rather than a
  token scoped to your existing user): a one-time interactive login
  (`npm run login`, run on your own machine, not in the container) mints a
  30-day refresh token (`frontend/src/auth.ts`'s flow), saved to a JSON
  file. The container exchanges it for a 1-hour access JWT on startup and
  ~5 minutes before every expiry (`src/auth/oauthTokenProvider.ts`). Refresh
  tokens **rotate on every use** (`src/auth/oauth.ts`'s `claimRefreshToken`),
  so the container persists the newly issued refresh token back to the same
  file after every refresh — mount that file on a real volume, and run
  exactly one container per credential file (a second replica sharing the
  file will race the rotation and lock the other out).

**`catalog_snapshots` table.** When catalog views are enabled, SQL also sees
a `catalog_snapshots(table_name, snapshot_id, uri, url, backend, format,
created_at)` table exposing every historical snapshot of every table (not
just the latest, like the per-table views) — mirrors
`frontend/src/catalogSnapshots.ts`. `url` is a directly-readable `s3://...`
URL, NULL for `http-ds://` snapshots or ones on a since-deleted backend.
Since `@duckdb/node-api` has no virtual-file registration API like
duckdb-wasm's `registerFileText()`, rows are loaded via a plain bulk
`INSERT` instead (`src/catalog/snapshots.ts`).

## Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `WORKER_URL` | yes | — | Worker origin, e.g. `https://data-shack.example.workers.dev` |
| `AUTH_MODE` | no | `dev-token` | `token`, `dev-token`, or `oauth-refresh` |
| `API_TOKEN` | if `AUTH_MODE=token` | — | An API token from `dshack auth create-token`, the Workbench UI, or `POST /api/tokens` |
| `DEV_TOKEN` | if `AUTH_MODE=dev-token` | — | Must match the Worker's `DEV_TOKEN` secret |
| `AUTH_CREDENTIALS_PATH` | if `AUTH_MODE=oauth-refresh` | `/data/credentials.json` | Path to the file produced by `npm run login` |
| `ENABLE_CATALOG_VIEWS` | no | `true` | Also connect to `/catalog/ws` and register `CREATE VIEW` per catalog table, so SQL can reference tables by name, and load the full snapshot history as a `catalog_snapshots` table (see below). Set `false` to skip if you only ever query raw `r2://`/`http-ds://` URIs directly. |
| `DUCKDB_PATH` | no | `:memory:` | DuckDB database file, or `:memory:` |
| `DUCKDB_EXTENSION_DIR` | no | — | Fixed extension cache dir; set by the Docker image, leave unset locally |
| `LOG_LEVEL` | no | `info` | `debug`\|`info`\|`warn`\|`error` |

## Local development

```bash
npm install
npm run typecheck

# token mode — create a token in the Workbench UI first (Settings → API Tokens)
WORKER_URL=http://localhost:8787 AUTH_MODE=token API_TOKEN=dsk_... \
  npm run build && npm start

# dev-token mode
WORKER_URL=http://localhost:8787 AUTH_MODE=dev-token DEV_TOKEN=some-local-secret \
  npm run build && npm start

# oauth-refresh mode — one-time login, then run
WORKER_URL=https://your-worker.example.workers.dev npm run login   # writes ./credentials.json
WORKER_URL=https://your-worker.example.workers.dev AUTH_MODE=oauth-refresh \
  AUTH_CREDENTIALS_PATH=./credentials.json npm run build && npm start
```

## Docker

```bash
docker build -t data-shack-session-client .

docker run --rm \
  -e WORKER_URL=https://your-worker.example.workers.dev \
  -e AUTH_MODE=token \
  -e API_TOKEN=dsk_... \
  data-shack-session-client

# oauth-refresh mode needs a writable volume for the rotating refresh token:
docker run --rm \
  -e WORKER_URL=https://your-worker.example.workers.dev \
  -e AUTH_MODE=oauth-refresh \
  -v "$(pwd)/credentials.json:/data/credentials.json" \
  data-shack-session-client
```

Or `docker compose up` using the included `docker-compose.yml` (reads
`WORKER_URL`/`AUTH_MODE`/`DEV_TOKEN` from your shell or a `.env` file).

The image pre-caches the DuckDB `httpfs` extension at build time
(`docker/install-httpfs.mjs`) so the running container never needs outbound
access to `extensions.duckdb.org` — only to your Worker's origin and the
storage backends it proxies to.

## Deploying

See [`deploy/README.md`](./deploy/README.md) for a comparison of hosting
options, including a researched (but not yet implemented) feasibility
write-up for running this on Cloudflare Containers (Workers paid plan).
