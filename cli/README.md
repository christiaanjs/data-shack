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

Pass `--pull` to fetch all existing resources from the API and write them as YAML files. Useful for bootstrapping IaC on top of a pre-existing deployment.

### `dshack plan`

Reads all YAML files in `data-sources/`, `transforms/`, and `catalog/`, resolves secret references, and computes a diff against `.dshack/state.json`.

```
  + data-sources/stripe.yaml     [credential]   ← will be created
  ~ transforms/enrich.yaml       [transform]    ← config changed
  - catalog/old-query.yaml       [saved-query]  ← no longer in files

Plan: 1 to add, 1 to change, 1 to destroy.
```

Exits non-zero if any secret reference cannot be resolved.

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
└── catalog/
    └── monthly-summary.yaml
```

Subdirectory layout is up to you — all `.yaml` / `.yml` files under the three top-level directories are discovered recursively.

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
sql: |
  SELECT t.*, c.name AS category_name
  FROM transactions t
  JOIN categories c ON t.category_id = c.id
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
sql: |
  SELECT
    strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month,
    SUM(amount) / 100.0 AS revenue_usd
  FROM transactions
  GROUP BY month
  ORDER BY month DESC
```

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
