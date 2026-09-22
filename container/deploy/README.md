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

## Free-tier options considered

| Option | Actually free long-term? | Fits "always-on, no inbound trigger"? | Notes |
|---|---|---|---|
| **Oracle Cloud Always Free** (recommended) | Yes — no time limit, no credit-card charge while within Always Free limits | Yes — it's a real VM you run Docker on | Up to 4 OCPU / 24 GB on the Ampere A1 shape (or 2× `VM.Standard.E2.1.Micro`), 200 GB block storage, ~10 TB/mo egress, all Always Free as of writing. Requires a credit card at signup for identity verification (not charged unless you explicitly upgrade). Some regions have had capacity shortages provisioning the free Ampere shape — retry or pick another AD/region if so. **Verify current limits on Oracle's site before provisioning — free-tier terms do change.** |
| Fly.io | **No** — the indefinite free allowance was discontinued (Nov 2024); now pay-as-you-go with a small one-time trial credit | Yes, architecturally (`fly.toml` + persistent Machines, no idle-sleep) | Good if a few $/month is acceptable — simplest deploy UX of anything here (`fly deploy` from the `container/` directory with a generated `fly.toml`). Not included as IaC below since it isn't actually free. |
| Render | Free tier only for Web Services, which **spin down after 15 min of inactivity** | No | A sleeping instance has no live WS to route queries to; background workers that don't sleep require a paid plan. Doesn't fit. |
| Google Cloud Run | Generous Always Free request/compute-time allowance, but it's metered by request and idles to zero by default | Only with `min-instances=1` + "CPU always allocated", which bills continuously past the free allowance | Doesn't stay within Always Free for a 24/7 background connection. |
| Koyeb | Free tier includes one always-on "Nano" web service (no forced idle-sleep) | Yes | A lighter-weight alternative to running your own VM if you'd rather not manage OCI — smaller/less battle-tested free allowance, no Terraform provider used here, deploy via their CLI/dashboard instead. Worth trying if Oracle capacity is a problem in your region. |

**Recommendation:** Oracle Cloud Always Free, provisioned with the Terraform
in `oracle-always-free/`. It's the only option here that's both genuinely
free indefinitely and a real persistent host, which is exactly what this
workload needs.

## `oracle-always-free/`

Terraform that provisions:
- A minimal VCN (public subnet, internet gateway, security list allowing
  outbound-all and inbound SSH only from a CIDR you specify — the container
  itself needs no inbound port).
- One `VM.Standard.A1.Flex` Always Free instance (Ubuntu).
- `cloud-init` that installs Docker, clones this repo, builds the image from
  `container/`, and runs it as a `systemd` service (`Restart=always`), so it
  comes back up on crash or VM reboot without any manual intervention.

See `oracle-always-free/README.md` for setup steps, including the extra
manual step `AUTH_MODE=oauth-refresh` needs (copying the rotating credential
file to the VM — deliberately kept out of Terraform state/user-data since
it's a live secret that rotates on every use).
