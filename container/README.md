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

**Persistent, not hibernating.** This process holds one WebSocket open for
its entire lifetime, pinging every 25s (the Session DO marks a socket stale
after 3 missed pings — `src/session/do.ts`). It does *not* try to scale to
zero or reconnect lazily on demand. That's a deliberate choice: the DO
already hibernates on Cloudflare's side between messages (`ctx.acceptWebSocket`),
which is what makes a permanently-open socket from this side cheap for them —
but there is no live socket at all while this process is down, and a query
arriving in that window fails immediately with `no_session`
(`src/mcp/server.ts`'s `handleRunQuery`). A scale-to-zero container platform
(Cloud Run/Lambda-style, cold-starting on inbound HTTP) doesn't fit this
workload, since nothing here receives inbound HTTP to trigger a cold start —
the only inbound traffic is the WS push from the DO once a socket already
exists. So the deployment target needs to be an always-on host, not a
request-triggered FaaS; see `deploy/README.md`.

**Auth: two supported modes**, both already supported by the existing Worker
with no server-side changes:

- **`AUTH_MODE=dev-token`** (default, simplest) — a static shared secret,
  matching the Worker's `ENABLE_DEV_AUTH` bypass
  (`src/auth/middleware.ts`). No expiry, no refresh logic, no persistent
  volume needed. Give this container its own `DEV_TOKEN`/`DEV_USER_ID`
  secret pair on the Worker — don't reuse your local-dev or CI secret — since
  it's effectively a long-lived bearer credential for whatever `DEV_USER_ID`
  you configure.
- **`AUTH_MODE=oauth-refresh`** — proper per-user OAuth: a one-time
  interactive login (`npm run login`, run on your own machine, not in the
  container) mints a 30-day refresh token via the same DCR + PKCE flow the
  frontend uses (`frontend/src/auth.ts`), saved to a JSON file. The container
  exchanges it for a 1-hour access JWT on startup and ~5 minutes before every
  expiry (`src/auth/oauthTokenProvider.ts`). Refresh tokens **rotate on every
  use** (`src/auth/oauth.ts`'s `claimRefreshToken`), so the container
  persists the newly issued refresh token back to the same file after every
  refresh — mount that file on a real volume, and run exactly one container
  per credential file (a second replica sharing the file will race the
  rotation and lock the other out).

Pick `dev-token` unless you specifically want the container to act as a
distinct, revocable Google identity rather than a shared secret.

## Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `WORKER_URL` | yes | — | Worker origin, e.g. `https://data-shack.example.workers.dev` |
| `AUTH_MODE` | no | `dev-token` | `dev-token` or `oauth-refresh` |
| `DEV_TOKEN` | if `AUTH_MODE=dev-token` | — | Must match the Worker's `DEV_TOKEN` secret |
| `AUTH_CREDENTIALS_PATH` | if `AUTH_MODE=oauth-refresh` | `/data/credentials.json` | Path to the file produced by `npm run login` |
| `ENABLE_CATALOG_VIEWS` | no | `true` | Also connect to `/catalog/ws` and register `CREATE VIEW` per catalog table, so SQL can reference tables by name. Set `false` to skip if you only ever query raw `r2://`/`http-ds://` URIs directly. |
| `DUCKDB_PATH` | no | `:memory:` | DuckDB database file, or `:memory:` |
| `DUCKDB_EXTENSION_DIR` | no | — | Fixed extension cache dir; set by the Docker image, leave unset locally |
| `LOG_LEVEL` | no | `info` | `debug`\|`info`\|`warn`\|`error` |

## Local development

```bash
npm install
npm run typecheck

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
  -e AUTH_MODE=dev-token \
  -e DEV_TOKEN=some-secret \
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

See [`deploy/README.md`](./deploy/README.md) for a comparison of free-tier
hosting options and Terraform for the recommended one (an Oracle Cloud
Always Free VM).
