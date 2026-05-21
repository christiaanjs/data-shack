#!/usr/bin/env bash
# bootstrap.sh — Provision a data-shack environment from scratch.
#
# Usage:
#   ./scripts/bootstrap.sh [--env production|staging|local] [--deploy]
#
# What it does:
#   1. Creates the D1 database (idempotent) and patches wrangler.toml
#   2. Applies D1 migrations
#   3. Walks you through creating a Google OAuth 2.0 client
#   4. Generates a JWT_SECRET
#   5. Pushes all secrets to Cloudflare (or writes .dev.vars for local)
#   6. Optionally deploys the worker
#
# Prerequisites: wrangler (or npx), openssl, jq

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_TOML="$REPO_ROOT/wrangler.toml"

# ── Colour helpers ─────────────────────────────────────────────────────────────

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()  { echo; echo -e "${CYAN}${BOLD}── $* ──${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $*"; }
warn()  { echo -e "  ${YELLOW}!${NC} $*"; }
info()  { echo -e "  $*"; }
ask()   { echo -e -n "${BOLD}  ? $* ${NC}"; }
die()   { echo -e "${BOLD}Error:${NC} $*" >&2; exit 1; }

# ── Argument parsing ───────────────────────────────────────────────────────────

ENV="production"
DEPLOY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)    ENV="$2"; shift 2 ;;
    --deploy) DEPLOY=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--env production|staging|local|<name>] [--deploy]"
      exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# ── Per-environment config ─────────────────────────────────────────────────────

case "$ENV" in
  production)
    CF_ENV_ARGS=()
    DB_NAME="data-shack-db"
    DB_TOML_PLACEHOLDER="REPLACE_WITH_YOUR_DB_ID"
    QUEUE_NAME="data-shack-load-jobs"
    DEFAULT_WORKER_URL="https://data-shack.workers.dev"
    ;;
  staging)
    CF_ENV_ARGS=(--env staging)
    DB_NAME="data-shack-db-staging"
    DB_TOML_PLACEHOLDER="REPLACE_WITH_YOUR_STAGING_DB_ID"
    QUEUE_NAME="data-shack-load-jobs-staging"
    DEFAULT_WORKER_URL="https://data-shack-staging.workers.dev"
    ;;
  local)
    CF_ENV_ARGS=()
    DB_NAME="data-shack-db"
    DB_TOML_PLACEHOLDER=""
    QUEUE_NAME=""
    DEFAULT_WORKER_URL="http://localhost:8787"
    ;;
  *)
    CF_ENV_ARGS=(--env "$ENV")
    DB_NAME="data-shack-db-$ENV"
    DB_TOML_PLACEHOLDER=""
    QUEUE_NAME="data-shack-load-jobs-$ENV"
    DEFAULT_WORKER_URL="https://data-shack-$ENV.workers.dev"
    ;;
esac

echo -e "${BOLD}data-shack bootstrap${NC} — environment: ${CYAN}${BOLD}$ENV${NC}"

# ── Check dependencies ─────────────────────────────────────────────────────────

step "Checking dependencies"

command -v openssl >/dev/null 2>&1 || die "openssl not found"
command -v jq      >/dev/null 2>&1 || die "jq not found (brew install jq / apt install jq)"

if command -v wrangler >/dev/null 2>&1; then
  W="wrangler"
else
  W="npx --yes wrangler"
  info "wrangler not installed globally — using npx"
fi

ok "Dependencies OK"

# ── LOCAL: short-circuit path ──────────────────────────────────────────────────

if [[ "$ENV" == "local" ]]; then
  step "Applying local D1 migrations"
  cd "$REPO_ROOT"
  $W d1 migrations apply "$DB_NAME" --local
  ok "Migrations applied"

  step "Writing .dev.vars"
  DEV_VARS="$REPO_ROOT/.dev.vars"
  touch "$DEV_VARS"

  # JWT_SECRET — generate if missing
  if grep -q "^JWT_SECRET=" "$DEV_VARS" 2>/dev/null; then
    ok "JWT_SECRET already present"
  else
    JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n=')
    printf '\nJWT_SECRET=%s\n' "$JWT_SECRET" >> "$DEV_VARS"
    ok "JWT_SECRET generated and appended"
  fi

  # Google credentials — remind if missing
  if ! grep -q "^GOOGLE_CLIENT_ID=" "$DEV_VARS" 2>/dev/null; then
    warn "Google credentials not found in .dev.vars"
    info ""
    info "Create a Google OAuth 2.0 Web Application client at:"
    info "  https://console.cloud.google.com/apis/credentials"
    info ""
    info "Authorised redirect URI: http://localhost:8787/oauth/callback"
    info ""
    info "Then add to .dev.vars:"
    info "  GOOGLE_CLIENT_ID=<client-id>"
    info "  GOOGLE_CLIENT_SECRET=<client-secret>"
  else
    ok "Google credentials present"
  fi

  # Remind about other optional local vars
  if ! grep -q "^ALLOWED_ORIGIN=" "$DEV_VARS" 2>/dev/null; then
    printf '\nALLOWED_ORIGIN=http://localhost:5173\n' >> "$DEV_VARS"
    ok "ALLOWED_ORIGIN=http://localhost:5173 added"
  fi

  echo
  info "Optional: add to .dev.vars for dev-token auth (skips OAuth in the browser):"
  info "  ENABLE_DEV_AUTH=true"
  info "  DEV_TOKEN=<any string>"
  info "  DEV_USER_ID=usr_local"
  echo
  info "Start worker:   npm run dev"
  info "Start frontend: cd frontend && npm run dev"
  echo
  ok "Local bootstrap complete"
  exit 0
fi

# ── CLOUD: full bootstrap ──────────────────────────────────────────────────────

cd "$REPO_ROOT"

# ── Step 1: D1 database ───────────────────────────────────────────────────────

step "D1 database"

# Check if database already exists (idempotent)
DB_ID=$(
  $W d1 list --json 2>/dev/null \
  | jq -r ".[] | select(.name == \"$DB_NAME\") | .uuid" 2>/dev/null \
  || true
)

if [[ -n "$DB_ID" ]]; then
  ok "Database '$DB_NAME' already exists — skipping create (id: $DB_ID)"
else
  info "Creating database '$DB_NAME'…"
  # Capture output; wrangler prints the ID in the table
  CREATE_OUT=$($W d1 create "$DB_NAME" 2>&1 || true)
  DB_ID=$(
    echo "$CREATE_OUT" \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1 || true
  )
  [[ -n "$DB_ID" ]] || die "Could not extract database ID from wrangler output:\n$CREATE_OUT"
  ok "Created database '$DB_NAME' (id: $DB_ID)"
fi

# Patch wrangler.toml if the placeholder is still there
if [[ -n "$DB_TOML_PLACEHOLDER" ]]; then
  if grep -q "$DB_TOML_PLACEHOLDER" "$WRANGLER_TOML"; then
    # perl -i works on both macOS and Linux
    perl -i -pe "s/\Q$DB_TOML_PLACEHOLDER\E/$DB_ID/g" "$WRANGLER_TOML"
    ok "Patched wrangler.toml: $DB_TOML_PLACEHOLDER → $DB_ID"
  else
    ok "wrangler.toml already has database_id set"
  fi
else
  warn "Custom env '$ENV': add the following to wrangler.toml manually if not present:"
  info ""
  info "  [[env.$ENV.d1_databases]]"
  info "  binding = \"DB\""
  info "  database_name = \"$DB_NAME\""
  info "  database_id = \"$DB_ID\""
  info ""
fi

# Apply migrations
info "Applying migrations…"
$W d1 migrations apply "$DB_NAME" "${CF_ENV_ARGS[@]+${CF_ENV_ARGS[@]}}"
ok "Migrations applied"

# ── Step 2: Cloudflare Queue ──────────────────────────────────────────────────

step "Cloudflare Queue"

if [[ -n "$QUEUE_NAME" ]]; then
  QUEUE_EXISTS=$(
    $W queues list 2>/dev/null \
    | grep -F "$QUEUE_NAME" || true
  )
  if [[ -n "$QUEUE_EXISTS" ]]; then
    ok "Queue '$QUEUE_NAME' already exists — skipping create"
  else
    info "Creating queue '$QUEUE_NAME'…"
    CREATE_QUEUE_OUT=$($W queues create "$QUEUE_NAME" 2>&1 || true)
    if echo "$CREATE_QUEUE_OUT" | grep -qi "already exists"; then
      ok "Queue '$QUEUE_NAME' already exists"
    elif echo "$CREATE_QUEUE_OUT" | grep -qi "error\|failed"; then
      die "Failed to create queue '$QUEUE_NAME':\n$CREATE_QUEUE_OUT"
    else
      ok "Created queue '$QUEUE_NAME'"
    fi
  fi
else
  warn "No queue name set for env '$ENV' — skipping"
fi

# ── Step 3: Google OAuth 2.0 client ───────────────────────────────────────────

step "Google OAuth credentials"
info ""
info "Google's CLI does not support creating Web Application OAuth clients."
info "Create one manually in ~2 minutes:"
info ""
info "  1. Go to: https://console.cloud.google.com/apis/credentials"
info "  2. Click 'Create Credentials' → 'OAuth client ID'"
info "  3. Application type: Web application"
info "  4. Add authorised redirect URI:"
info "     ${DEFAULT_WORKER_URL}/oauth/callback"
info "  5. Copy the Client ID and Client Secret"
info ""

if command -v open >/dev/null 2>&1; then
  ask "Open the Google Cloud Console now? [y/N]: "
  read -r OPEN_CONSOLE
  [[ "$OPEN_CONSOLE" =~ ^[Yy]$ ]] && open "https://console.cloud.google.com/apis/credentials"
fi

ask "Google Client ID: "
read -r GOOGLE_CLIENT_ID
[[ -n "$GOOGLE_CLIENT_ID" ]] || die "Client ID cannot be empty"

ask "Google Client Secret: "
read -rs GOOGLE_CLIENT_SECRET
echo
[[ -n "$GOOGLE_CLIENT_SECRET" ]] || die "Client Secret cannot be empty"
ok "Google credentials captured"

# ── Step 4: JWT secret ────────────────────────────────────────────────────────

step "JWT secret"
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n=')
ok "Generated ($(echo -n "$JWT_SECRET" | wc -c | tr -d ' ') chars)"

# ── Step 5: Push secrets to Cloudflare ────────────────────────────────────────

step "Pushing secrets to Cloudflare (env: $ENV)"

push_secret() {
  local name="$1" value="$2"
  printf '%s' "$value" | $W secret put "$name" "${CF_ENV_ARGS[@]+${CF_ENV_ARGS[@]}}"
  ok "$name"
}

push_secret GOOGLE_CLIENT_ID     "$GOOGLE_CLIENT_ID"
push_secret GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
push_secret JWT_SECRET           "$JWT_SECRET"

# ── Step 6: Optional deploy ───────────────────────────────────────────────────

if $DEPLOY; then
  step "Deploying worker ($ENV)"
  $W deploy "${CF_ENV_ARGS[@]+${CF_ENV_ARGS[@]}}"
  ok "Worker deployed"
else
  echo
  warn "Worker not deployed. Run when ready:"
  info "  $W deploy ${CF_ENV_ARGS[*]+${CF_ENV_ARGS[*]}}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

step "Next steps"
info "1. Deploy the worker (if not done):  $W deploy ${CF_ENV_ARGS[*]+${CF_ENV_ARGS[*]}}"
info "2. Note your worker URL and set it as VITE_WORKER_URL in Cloudflare Pages settings"
info "3. Set ALLOWED_ORIGIN in wrangler.toml to match your Pages domain, then redeploy"
info "4. If you want ENABLE_DEV_AUTH for this env, run:"
info "   printf 'true' | $W secret put ENABLE_DEV_AUTH ${CF_ENV_ARGS[*]+${CF_ENV_ARGS[*]}}"
info "   printf '<token>' | $W secret put DEV_TOKEN ${CF_ENV_ARGS[*]+${CF_ENV_ARGS[*]}}"
info "   printf '<userId>' | $W secret put DEV_USER_ID ${CF_ENV_ARGS[*]+${CF_ENV_ARGS[*]}}"
echo
ok "Bootstrap complete for [$ENV]"
