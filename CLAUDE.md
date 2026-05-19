# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Bootstrap a new environment

```bash
./scripts/bootstrap.sh                   # production (default)
./scripts/bootstrap.sh --env staging     # staging
./scripts/bootstrap.sh --env local       # local dev (.dev.vars)
./scripts/bootstrap.sh --env production --deploy  # bootstrap + deploy in one step
```

The script:
1. Creates the D1 database (idempotent — skips if already exists) and patches `wrangler.toml`
2. Applies all D1 migrations
3. Walks you through creating a Google OAuth 2.0 Web Application credential (console link + prompt)
4. Generates a `JWT_SECRET` via `openssl`
5. Pushes all secrets to Cloudflare via `wrangler secret put` (or writes `.dev.vars` for local)

Requires: `wrangler` (or npx), `openssl`, `jq`.

## Pre-commit checklist

Before every commit, run all three checks from the repo root:

```bash
npm test          # 43 vitest tests via @cloudflare/vitest-pool-workers
npm run typecheck # tsc for worker + tsc -p test/tsconfig.json
npm run lint      # biome check . (lint + format + import order)
```

To auto-fix most lint/format issues: `npx biome check --fix --unsafe .`

Frontend has its own typecheck (no test suite yet):

```bash
cd frontend && npm run typecheck
```

## Repository structure

Two independent packages share this repo:

- **Root** (`src/`, `test/`, `migrations/`) — Cloudflare Worker (Hono + D1 + Wrangler)
- **`frontend/`** — Cloudflare Pages SPA (Preact + Vite)

They have separate `node_modules`, `package.json`, and `tsconfig.json`. The worker has no dependency on the frontend and vice versa. Biome's `lint` runs from the root and covers both (`biome check .` traverses `frontend/src/` too).

## Worker architecture

**Entry point:** `src/index.ts` — Hono app with CORS middleware, `requireAuth` middleware, and two route groups: the OAuth router and authenticated endpoints.

**Auth flow:**
1. `authenticate()` in `src/auth/middleware.ts` checks for `X-Dev-Token` header first (when `ENABLE_DEV_AUTH=true`), then validates a Bearer JWT via `src/auth/jwt.ts` (HMAC-HS256).
2. All OAuth endpoints live in `src/auth/oauth.ts` via `oauthRouter`. The flow: `/authorize/:provider` → Google OAuth → `/oauth/callback` → exchange code → issue MCP auth code → redirect to client → client POSTs to `/token` → receives JWT + refresh token.
3. Provider support is Google-only. Passing any other provider to `/authorize/:provider` returns `400 invalid_request`.

**D1 query layer:** `src/db/queries.ts` for user/identity operations, `src/db/oauth.ts` for OAuth table operations. All SQL is in these files — no inline SQL elsewhere.

**User identity model:** Each user is their own tenant (no household concept). `oauth_identities` maps (provider, provider_id) → user. On login, the resolution order is: existing identity → link by verified email → create new user. Email is nullable on `users` — providers that don't return a verified email still work.

**Token lifetimes:** Access tokens 1 hour (JWT), refresh tokens 30 days (stored as SHA-256 hashes in D1, rotated on every use).

**Key D1 tables:** `users`, `oauth_identities`, `oauth_states`, `oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`. All `expires_at` columns are Unix milliseconds (`Date.now()`).

## Frontend architecture

Single-file auth client in `frontend/src/auth.ts` — handles DCR (Dynamic Client Registration), PKCE code verifier generation, token exchange, auto-refresh (5-minute buffer), and token storage in `localStorage`/`sessionStorage`.

`frontend/src/App.tsx` is an auth state machine: `null` (loading) → `false` (login screen) → `true` (authenticated). On load it either handles the `/callback` route (token exchange) or checks for an existing access token. After authentication it calls `GET /me` to resolve `userId`.

`VITE_DEV_TOKEN` in the frontend environment skips OAuth entirely — the token is sent as `X-Dev-Token` on every request.

## Local development

**Worker:**

```bash
# Required .dev.vars (gitignored):
# GOOGLE_CLIENT_ID=<local Google OAuth app>
# GOOGLE_CLIENT_SECRET=<local Google OAuth app>
# JWT_SECRET=<any 32+ char string>
# ALLOWED_ORIGIN=http://localhost:5173
# ENABLE_DEV_AUTH=true
# DEV_TOKEN=some-local-secret
# DEV_USER_ID=usr_local

npm run dev          # Worker on http://localhost:8787
npm run migrate:local  # Apply migrations to local D1
```

**Frontend:**

```bash
# Required frontend/.env.local (gitignored):
# VITE_WORKER_URL=http://localhost:8787
# VITE_DEV_TOKEN=some-local-secret   # optional, skips OAuth

cd frontend && npm run dev  # SPA on http://localhost:5173
```

## Testing

Tests run in the real Workers runtime via `@cloudflare/vitest-pool-workers` with Miniflare. The `test/setup.ts` runs `applyD1Migrations` once per test file. All bindings (including D1) are in-memory — no Cloudflare account needed.

Run a single test by name:

```bash
npm test -- --reporter=verbose -t "test name substring"
```

## Adding new routes

1. Add the handler to `src/index.ts` behind `requireAuth` for protected routes.
2. Add any D1 queries to `src/db/queries.ts`.
3. Add the `Env` binding in `src/types.ts` if a new binding is needed.
4. Add corresponding tests in `test/oauth.test.ts` (or a new test file) — use the `SELF` export from `cloudflare:test` to make real HTTP requests against the worker.

## Migrations

```bash
npm run migration:new -- <migration-name>   # creates a new numbered file in migrations/
npm run migrate:local                        # applies to local D1
wrangler d1 migrations apply data-shack-db  # applies to production D1
```

The `TEST_MIGRATIONS` binding in `vitest.config.ts` is populated from the `migrations/` directory at test startup — new migration files are picked up automatically.
