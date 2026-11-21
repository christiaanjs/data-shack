# dshack

IaC CLI for data-shack. Declare warehouse resources as YAML files, track state locally, and sync to the live API with plan/apply — similar to Terraform.

## Installation

```bash
cd cli
npm install
npm run build
npm link          # makes `dshack` available globally
```

## Quick start

```bash
# 1. Authenticate
dshack auth login https://your-worker.workers.dev

# 2. Initialise a workspace (creates .dshack/, data-sources/, transforms/, catalog/)
dshack init https://your-worker.workers.dev

# — or pull existing resources from the API into YAML files —
dshack init https://your-worker.workers.dev --pull

# 3. Write resource YAML files (see schemas below), then:
dshack plan     # preview what will change
dshack apply    # apply changes
```

## Commands

### `dshack auth`

```
dshack auth login <worker-url>          # Browser OAuth (PKCE)
dshack auth token <worker-url> <jwt>    # Store a token directly (CI/dev)
dshack auth create-token <name> [--expires-days N]  # Mint a long-lived CI API token
dshack auth status                      # Show current auth
dshack auth logout                      # Remove stored credentials
```

Credentials are stored in `~/.config/dshack/auth.json` (mode 600). You can also use the `DS_TOKEN` and `DS_WORKER_URL` environment variables to bypass stored auth — useful in CI.

### `dshack init <worker-url>`

Scaffolds the workspace:

```
.dshack/state.json    ← tracks resource IDs and config hashes
data-sources/         ← credentials, storage backends, load jobs
transforms/           ← transform jobs (with triggers)
catalog/              ← saved queries
```

Pass `--pull` to fetch all existing resources from the API and write them as YAML files, and record them in `.dshack/state.json` so an immediate `plan` shows no changes. Useful for bootstrapping IaC on top of a pre-existing deployment.

Secret values (http credential `variables`, and any config key containing `secret`, `token`, `password` or `key`) are **never written to disk**: they are replaced with `$ENV:NAME` references and the required variable names are printed. Export them before running `plan`/`apply`.

**Proxies:** the CLI honours `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (Node's built-in fetch does not).

### `dshack plan`

Reads all YAML files in `data-sources/`, `transforms/`, and `catalog/`, resolves secret references, and computes a diff against `.dshack/state.json`.

```
  + data-sources/stripe.yaml     [credential]   ← will be created
  ~ transforms/enrich.yaml       [transform]    ← config changed
  - catalog/old-query.yaml       [saved-query]  ← no longer in files

Plan: 1 to add, 1 to change, 1 to destroy.
```

Resources are compared by the hash of the YAML as written (with `$ENV:` references unresolved), so `plan` and `apply` need **no secret env vars** when nothing secret-bearing is being created or updated. Secrets are resolved only for resources that will be written; a plan lists any that are missing, and `apply` refuses to run until they are set. Consequence: rotating a secret's *value* without editing the YAML is not detected as a change.

### `dshack apply`

Executes the plan — creates, updates, and deletes resources via the API. Resources are applied in dependency order (credentials → backends → load jobs/transforms/queries). Prompts for confirmation unless `--yes` / `-y` is passed.

State is written to `.dshack/state.json` after each resource so a partial failure is resumable.

### `dshack destroy <path>`

Deletes a single tracked resource by its YAML path and removes it from state.

```bash
dshack destroy data-sources/stripe.yaml
dshack destroy transforms/enrich.yaml --yes
```

## Workspace structure

```
my-warehouse/
├── .dshack/
│   └── state.json          ← commit this; it maps YAML paths → resource IDs + hashes
├── data-sources/
│   ├── credentials/        ← optional subdirectory — paths are arbitrary
│   │   └── stripe.yaml
│   ├── backends/
│   │   └── main-r2.yaml
│   └── jobs/
│       └── transactions.yaml
├── transforms/
│   └── enriched-sales.yaml
├── catalog/
│   ├── monthly-summary.yaml
│   └── monthly-summary.sql     ← SQL lives in its own file (see below)
└── dashboards/
    └── spending/
        ├── dashboard.yaml
        ├── artifact.jsx        ← React + Recharts component
        └── monthly-totals.sql
```

Subdirectory layout is up to you — all `.yaml` / `.yml` files under the four top-level directories are discovered recursively.

## SQL and JSX in their own files

So editors can highlight them, long text fields can live next to the YAML instead of inside it. A `*_file` field replaces the inline field; paths are relative to the YAML file. `init --pull` writes this layout. Inline `sql:` / `queries:` still work, and a resource hashes the same either way. Trailing whitespace is ignored, and a missing referenced file is an error.

| Kind | Inline field | File field | Extension |
|---|---|---|---|
| `transform`, `saved-query` | `sql` | `sql_file` | `.sql` |
| `dashboard` | `artifact_source` | `artifact_file` | `.jsx` |
| `dashboard` | `queries` | `query_files` (list) | `.sql` |

## Secret references

Secret values in YAML configs are never written to disk. Use a reference that gets resolved at `plan`/`apply` time:

| Syntax | Resolution |
|---|---|
| `$DOPPLER:SECRET_NAME` | `doppler secrets get SECRET_NAME --plain`; falls back to env var `SECRET_NAME` if Doppler is unavailable |
| `$ENV:VAR_NAME` | `process.env.VAR_NAME` |

The config hash used for change detection is computed from the **resolved** values, so rotating a secret in Doppler will show as a change in `plan`.

## Resource schemas

### `kind: credential`

Maps to `POST /api/credentials`. The `config` object is encrypted at rest by the worker.

```yaml
kind: credential
name: stripe-api
type: http
config:
  base_url: https://api.stripe.com
  auth_type: bearer
  token: $DOPPLER:STRIPE_SECRET_KEY
```

### `kind: storage-backend`

Maps to `POST /api/storage-backends`.

```yaml
kind: storage-backend
name: main-r2
type: r2-s3compat
config:
  account_id: $ENV:CF_ACCOUNT_ID
  access_key_id: $DOPPLER:R2_KEY_ID
  secret_access_key: $DOPPLER:R2_SECRET
  bucket: my-warehouse
```

### `kind: load-job`

Maps to `POST /api/load-jobs`. References credential and storage backend **by name** — they must exist before the load job is applied (ordering is handled automatically when they live in the same workspace).

```yaml
kind: load-job
name: transactions-daily
credential: stripe-api          # credential name
storage_backend: main-r2        # storage backend name
table_name: transactions
table_path: raw/transactions/
http_path: /v1/charges
http_method: GET
format: json
cron_schedule: "0 2 * * *"
enabled: true
pagination_config:
  cursor_param: starting_after
  cursor_path: data.-1.id
  data_path: data
```

### `kind: transform`

Maps to `POST /api/transform-jobs`. Triggers are embedded directly in the YAML and managed as part of the same resource — no separate trigger files needed.

The `output_backend` field is optional; when omitted it is derived from the bucket segment of `output_uri`.

```yaml
kind: transform
name: enriched-transactions
output_table: enriched_transactions
output_uri: r2://main-r2/data/enriched/transactions.ndjson
format: ndjson
requires_browser: true          # default: true — runs SQL in DuckDB via browser session
sql_file: enriched-transactions.sql   # or inline: sql: |
triggers:
  - watches: [transactions, categories]
    policy: all        # fire only when both tables have new snapshots
  - watches: products
    policy: any        # fire whenever products updates (default)
```

### `kind: saved-query`

Maps to `POST /api/saved-queries`.

```yaml
kind: saved-query
name: monthly-revenue
sql_file: monthly-revenue.sql
```

### `kind: dashboard`

Maps to `/api/dashboards`. `queries[i]` is passed to the component as `data[i]`. `slug` is optional (derived from the title on create; omit it on update to keep the current one).

```yaml
kind: dashboard
title: Spending
slug: spending
artifact_file: artifact.jsx    # React component, default export, Recharts available
query_files:
  - monthly-totals.sql
  - by-category.sql
```

The API has no query names (the artifact reads `data[i]` by position), so a query can name itself with a leading `-- name: monthly-totals` comment. It is part of the SQL, so it survives the round-trip. `init --pull` names each file after that marker, else after the query's main `FROM` table, else `query-N` — it never edits the SQL. The order of `query_files` sets the index.

## State file

`.dshack/state.json` should be committed to version control. It contains no secrets — only resource IDs and hashes of the resolved config.

```json
{
  "version": 1,
  "worker_url": "https://your-worker.workers.dev",
  "resources": {
    "data-sources/credentials/stripe.yaml": {
      "id": "cred_abc123",
      "kind": "credential",
      "hash": "a1b2c3d4e5f6a7b8"
    },
    "transforms/enriched-transactions.yaml": {
      "id": "tj_xyz789",
      "kind": "transform",
      "hash": "f8e7d6c5b4a3f2e1",
      "trigger_ids": ["trg_def456"]
    }
  }
}
```

## CI/CD

Access JWTs expire after 1 hour, so CI should use a long-lived API token. Create one after `dshack auth login`:

```bash
dshack auth create-token github-actions --expires-days 365
```

The token (`dsk_…`) is shown once; store it as the `DSHACK_TOKEN` secret. Only a SHA-256 hash is kept server-side. Manage tokens with `GET /api/tokens` and `DELETE /api/tokens/:id` (revocation is immediate). API tokens cannot create other tokens.

Use `DS_TOKEN` and `DS_WORKER_URL` environment variables instead of stored auth:

```yaml
# GitHub Actions example
- name: dshack plan
  env:
    DS_TOKEN: ${{ secrets.DSHACK_TOKEN }}
    DS_WORKER_URL: https://your-worker.workers.dev
    STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
  run: |
    cd infra/
    npx dshack plan

- name: dshack apply
  if: github.ref == 'refs/heads/main'
  env:
    DS_TOKEN: ${{ secrets.DSHACK_TOKEN }}
    DS_WORKER_URL: https://your-worker.workers.dev
    STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
  run: |
    cd infra/
    npx dshack apply --yes
```
