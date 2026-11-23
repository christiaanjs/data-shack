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
| **Cloudflare Containers** (Workers paid plan) | ~$12–35/mo on top of the $5/mo Workers Standard plan, depending on instance size (see below) | Maybe, with a workaround | See next section — this is the one evaluated in most depth since the rest of this app already lives on Cloudflare. |

## Cloudflare Containers — feasibility (researched, not implemented)

Since the Worker/D1/R2/DO side of this app already runs on Cloudflare,
running the session container there too — on the Workers Standard ($5/mo)
paid plan's Containers product — was evaluated as a replacement for a
free-tier VM. Summary, current as of the Containers GA (April 2026):

**Verdict: feasible, with a real caveat, and not free.** Containers are
driven by a Durable Object that starts/stops them based on *inbound*
activity (`ctx.container` / the `@cloudflare/containers` SDK's
`renewActivityTimeout()` / `setInactivityTimeout()`, capped at 6 hours and
reset only by traffic the DO proxies *into* the container). This
container's entire job is the opposite shape — it only ever *initiates*
an outbound WebSocket, with zero inbound HTTP — so nothing in the normal
request path would renew its keep-alive timer, and it would get stopped by
Cloudflare on the usual idle schedule despite the socket it holds open
elsewhere.

That's solvable, not a dead end: a Durable Object's own `alarm()` handler
can call `renewActivityTimeout()`/`setInactivityTimeout()` on a recurring
schedule (under 6h) independent of real traffic, purely as a keep-alive
cron. It's a legitimate use of a documented API, just repurposed, and this
repo already has a natural place to put it — `src/session/do.ts` already
tracks this exact client's connection health. It just isn't built: doing
so means a DO class with a container binding, a `wrangler.toml` container
block, and a Dockerfile adjustment (Cloudflare builds from your Dockerfile
directly — no base-image requirement found), plus validating the native
`@duckdb/node-api` addon's prebuilt binary matches whatever CPU
architecture Cloudflare's container hosts run (not confirmed from public
docs at research time — would need a build-and-check).

**Cost**: instance tiers range from `lite` (1/16 vCPU, 256MiB) up through
`standard-4` (4 vCPU, 12GiB); billing is $0.0000025/GiB-sec memory (billed
on *provisioned* size, not usage) + $0.00002/vCPU-sec *active* CPU only +
disk + egress, on top of the $5/mo Workers Standard plan. DuckDB's memory
footprint likely needs at least `standard-1` (4GiB/8GB) to be comfortable,
which pencils out to roughly **$30–35/mo all-in** — well above a free VM,
though it is metered rather than a flat VM price.

**Net**: this is not a well-trodden Containers use case yet (Cloudflare's
own examples — code sandboxes, browser rendering, agent sandboxes — are
all request/response-shaped or Worker-initiates-into-container-shaped, not
"background worker, outbound-only"). If you'd like this built out despite
the cost and the keep-alive-alarm workaround it needs, say so and it can be
implemented as a new DO + container binding alongside the existing
`src/session/do.ts`; it hasn't been done preemptively given the tradeoffs
above.
