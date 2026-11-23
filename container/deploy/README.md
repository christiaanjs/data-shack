# Deploying the session container

## Why this needs an always-on host, not a FaaS

The container holds one persistent outbound WebSocket to the Worker's
`/session/ws` (see `../README.md`'s "Persistent, not hibernating" section).
Nothing about its job involves receiving inbound HTTP traffic — a query
arrives as a *push* over the socket it already holds. Scale-to-zero
platforms that cold-start on inbound HTTP (Cloud Run, Lambda, most
"serverless container" products) don't have a trigger to wake up on, so the
container would just stay asleep while queries fail upstream with
`no_session`. The deployment target needs to run the process continuously.

There's no IaC in this repo for a specific host right now — `docker build`
+ `docker run --restart unless-stopped` (or the included `docker-compose.yml`)
works on any VPS/host that gives you a persistent Docker runtime. The
options below were evaluated; none is wired up as Terraform/IaC here.

## Options considered

| Option | Cost | Fits "always-on, no inbound trigger"? | Notes |
|---|---|---|---|
| A VPS of your choice | Varies (a small instance is typically a few $/mo) | Yes | Plain `docker run --restart unless-stopped` or the included `docker-compose.yml`. The simplest option if you already have a host you trust. |
| Fly.io | Pay-as-you-go, no indefinite free tier (discontinued Nov 2024) | Yes, architecturally (`fly.toml` + persistent Machines, no idle-sleep) | Simplest deploy UX of anything here (`fly deploy` from `container/` with a generated `fly.toml`). |
| Koyeb | Free tier includes one always-on "Nano" web service (no forced idle-sleep) | Yes | Smaller/less battle-tested free allowance than a VM; deploy via their CLI/dashboard. |
| Render | Free only for Web Services, which **spin down after 15 min of inactivity** | No | A sleeping instance has no live WS to route queries to. |
| Google Cloud Run | Generous free allowance, but idles to zero by default | Only with `min-instances=1` + "CPU always allocated", billed continuously | Doesn't stay within the free allowance for a 24/7 background connection. |
| **Cloudflare Containers** (Workers paid plan) | Scales with actual usage — likely cents to a few $/mo for light/sporadic use, more under sustained query load (see below) | Yes — implemented | A container per user, started on demand by `SessionDO` and stopped after idling; see next section and `../../CLAUDE.md`'s "Container lifecycle" notes. |

## Cloudflare Containers — wake-on-query (implemented)

Since the Worker/D1/R2/DO side of this app already runs on Cloudflare,
`SessionDO` can also own a container for its user directly, via the
**Durable Object Container API** (`ctx.container` on `DurableObjectState` —
the current, non-deprecated generation; no `@cloudflare/containers` base
class needed, `SessionDO` stays a plain `DurableObject`). Rather than
keeping a container running 24/7 to dodge Cloudflare's idle-sleep (the
"keep-alive alarm" approach considered earlier and **not** what's built),
this works *with* idle-sleep: the container only runs while there's
actual work, which is what makes it cheap — memory/disk are billed only
while it's actually running.

**How it works:**
- `POST /query` (from `run_query`) and `POST /dispatch-jobs` (from catalog
  commits and the load-job queue) already prefer any live session — browser
  tab or previously-started container, whichever is already connected.
  Only when **nothing** is connected does `SessionDO` attempt
  `ctx.container.start()`, then wait (up to 45s) for the container's own
  outbound WS to register on `/session/ws` — the exact same path a browser
  tab uses, so no new wire protocol was needed.
- `POST /session/warm` (exposed as the `warm_session` MCP tool too) lets an
  MCP client or a browser with no local DuckDB session kick off that same
  cold start ahead of time, without waiting for it — so the latency
  overlaps with whatever happens next instead of landing on the first real
  query.
- The container is handed a **dedicated API token**, self-provisioned by
  `SessionDO` the first time it's needed (`POST /api/tokens` equivalent,
  named `container (auto)` — visible and revocable from Settings → API
  Tokens like any other token) and persisted in the DO's own durable
  storage, never in D1 as plaintext. If that token is later revoked,
  `SessionDO` notices (a cheap D1 existence check) and mints a fresh one.
- After starting, `SessionDO` calls `setInactivityTimeout(10 minutes)` —
  the platform's own mechanism, not a custom alarm loop — so the container
  stops itself after being idle, and gets re-armed from the DO's
  constructor if a DO restart happens while it's still running (the
  timeout doesn't survive that).
- Every one of the above is gated on `ctx.container` actually existing,
  which is `undefined` unless the deployment opted in via the
  `[[containers]]` block in `wrangler.toml` (commented out by default —
  see below). **Confirmed empirically**: this project's test suite
  (`@cloudflare/vitest-pool-workers`/Miniflare) also reports it as
  `undefined`, so none of this code is reachable there either — the
  existing 503 `no_session` behavior is completely unchanged for anyone
  who hasn't turned Containers on, which is also why it couldn't be
  integration-tested end-to-end in this environment (no Docker, no real
  Cloudflare account, no Miniflare container emulation — see the next
  paragraph).

**Turning it on**: uncomment the `[[containers]]` block in `wrangler.toml`
(and its `[env.staging.containers]` counterpart, if wanted there too) —
commented out by default since adding it makes `wrangler deploy`/`wrangler
dev` require Docker and a Containers-entitled Workers Paid plan, which
shouldn't become a surprise requirement on an existing deploy pipeline.
The exact `[[containers]]` fields (`class_name`, `image`, `instance_type`,
`max_instances`) were verified against this repo's actually-installed
`wrangler` version (`npx wrangler deploy --dry-run` parses the config and
gets as far as "Docker CLI could not be launched" — i.e. everything past
config parsing, which this sandbox can't go further on). What's **not**
verified against real infra: an actual deploy, a real cold-start timing
measurement, whether `@duckdb/node-api`'s prebuilt binary matches
Cloudflare's container CPU architecture, and the exact cost in practice.
Validate those on first real use.

**Cost**: instance tiers run `lite` (1/16 vCPU, 256MiB) through
`standard-4` (4 vCPU, 12GiB); billing is memory/disk on *provisioned* size
while running + *active* CPU only, metered in 10ms increments, on top of
the $5/mo Workers Standard plan (25 GiB-hour/375 vCPU-minute/200 GB-hour
included monthly). `standard-1` (1/2 vCPU, 4GiB/8GB) is configured by
default as a reasonable starting point for DuckDB's memory footprint.
Unlike the always-on alarm-keepalive approach, cost now scales with actual
running time rather than being a flat ~$30–35/mo regardless of use — light,
bursty usage should land far below that; sustained heavy query traffic
could approach it.

