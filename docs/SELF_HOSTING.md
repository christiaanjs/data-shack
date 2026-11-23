# Standing up your own data-shack

This guide takes you from nothing to a private data-shack instance running on your own Cloudflare account. Everything lives in your account: your D1 database, R2 bucket and Durable Objects. Only the Google accounts you allow-list can sign in.

Plan on 30–45 minutes. The steps are:

1. [Prerequisites](#1-prerequisites)
2. [Create the Cloudflare resources](#2-create-the-cloudflare-resources)
3. [Point `wrangler.toml` at your resources](#3-point-wranglertoml-at-your-resources)
4. [Create the Google OAuth client](#4-create-the-google-oauth-client)
5. [Set secrets and migrate the database](#5-set-secrets-and-migrate-the-database)
6. [Allow your email](#6-allow-your-email)
7. [Deploy the Worker](#7-deploy-the-worker)
8. [Deploy the frontend](#8-deploy-the-frontend)
9. [Finish configuration and sign in](#9-finish-configuration-and-sign-in)
10. [Optional extras](#10-optional-extras)

## 1. Prerequisites

- A Cloudflare account whose plan includes Workers, D1, R2, KV, Durable Objects, Queues and Pages. Check Cloudflare's current plan limits; R2 requires a payment method on file even within the free allowance.
- A Google account, to create the OAuth client and sign in.
- Node 22+, `git`, `openssl` and `jq` installed locally.
- Wrangler logged in to your account: `npx wrangler login`.

Clone the repo and install dependencies:

```bash
git clone https://github.com/christiaanjs/data-shack.git
cd data-shack
npm ci
(cd frontend && npm ci)
```

## 2. Create the Cloudflare resources

The repository's `wrangler.toml` holds resource IDs belonging to the original author's account, so you must create your own and substitute them. Create the four resources below (names are your choice; the ones shown match the defaults in `wrangler.toml`):

```bash
npx wrangler d1 create data-shack-db            # note the database_id it prints
npx wrangler r2 bucket create data-shack-storage
npx wrangler kv namespace create PROXY_CREDS_KV  # note the id it prints
npx wrangler queues create data-shack-load-jobs
```

Keep the D1 `database_id` and the KV `id`. Durable Objects need no creation step; they are created by the migrations in `wrangler.toml` on first deploy.

## 3. Point `wrangler.toml` at your resources

Edit the top-level (production) section of `wrangler.toml`:

| Setting | Change to |
|---|---|
| `[[d1_databases]]` `database_id` | the ID from `d1 create` |
| `[[d1_databases]]` `database_name` | your database name, if you changed it |
| `[[r2_buckets]]` `bucket_name` | your bucket name, if you changed it |
| `[[kv_namespaces]]` `id` | the ID from `kv namespace create` |
| `[[queues.producers]]` `queue` and `[[queues.consumers]]` `queue` | your queue name, if you changed it |
| `[vars]` `ALLOWED_ORIGIN` | the URL your frontend will have (see below) |

`ALLOWED_ORIGIN` is the origin of your Pages site. If you will name the Pages project `data-shack`, it is `https://data-shack.pages.dev`, but that name may be taken, so pick a unique project name (for example `data-shack-yourname`) and use `https://data-shack-yourname.pages.dev`. You can change it later by editing the file and redeploying.

The `[env.staging]` block is optional and can be ignored or deleted. If you want a staging copy, repeat this guide with `--env staging` and the staging values.

## 4. Create the Google OAuth client

Sign-in is Google OAuth, so you need your own OAuth client. Google's CLI cannot create Web Application clients, so this step is manual.

1. Open <https://console.cloud.google.com/apis/credentials> and select or create a project.
2. If prompted, configure the OAuth consent screen. For personal use, **External** with yourself added as a test user is sufficient.
3. **Create Credentials → OAuth client ID → Web application**.
4. Add an authorised redirect URI: `https://<your-worker-url>/oauth/callback`.
   Your Worker URL is `https://data-shack.<your-workers-subdomain>.workers.dev` for the default name. Find your subdomain in the Cloudflare dashboard under Workers & Pages. If you use a custom domain, use that.
5. Copy the **Client ID** and **Client secret**.

If you plan to load data from Google Sheets, also enable the **Google Sheets API** in the same project, and add the Sheets scope to the consent screen. Credentials of type `google-sheets` use the same client.

## 5. Set secrets and migrate the database

Three secrets are required. The bootstrap script sets them for you and also generates the JWT secret:

```bash
./scripts/bootstrap.sh
```

It will skip creating the database and queue because they already exist, prompt for the Google Client ID and secret, generate a `JWT_SECRET` and push all three to Cloudflare.

Or set them by hand:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | tr -d '\n=' | npx wrangler secret put JWT_SECRET
```

> **Back up `JWT_SECRET`.** It signs login tokens *and* is the key that encrypts the credentials and storage-backend configs you store in D1. If you lose or change it, saved credentials can no longer be decrypted and must be re-entered.

Apply the D1 migrations to the **remote** database. Do this explicitly even if you ran the bootstrap script, since Wrangler may apply migrations to a local copy unless told otherwise. Re-running is safe:

```bash
npx wrangler d1 migrations apply data-shack-db --remote
```

## 6. Allow your email

New accounts are admitted only if their verified email is in the `allowed_emails` table. The migrations seed that table with the project author's address, so add yours and then remove every other entry:

```bash
npx wrangler d1 execute data-shack-db --remote \
  --command "INSERT OR IGNORE INTO allowed_emails (email) VALUES ('you@example.com')"

npx wrangler d1 execute data-shack-db --remote \
  --command "DELETE FROM allowed_emails WHERE email != 'you@example.com'"
```

Use the exact address of the Google account you will sign in with. To invite someone else later, run the `INSERT` again with their address. Users who have already signed in once stay admitted regardless.

## 7. Deploy the Worker

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL. Check it is up. An unauthenticated request should be rejected:

```bash
curl -i https://<your-worker-url>/me     # expect 401
```

The Worker runs a cron every minute to dispatch due load jobs; nothing to configure for it.

## 8. Deploy the frontend

The frontend is a Cloudflare Pages site. The Worker URL is baked in at build time through `VITE_WORKER_URL`.

```bash
cd frontend
VITE_WORKER_URL=https://<your-worker-url> npm run build

npx wrangler pages project create data-shack-yourname --production-branch main
npx wrangler pages deploy dist --project-name data-shack-yourname --branch main
cd ..
```

Use the same project name you chose for `ALLOWED_ORIGIN` in step 3. The Pages Functions in `frontend/functions/` are deployed with the site automatically when `wrangler pages deploy` runs from `frontend/`; they provide per-dashboard titles and home-screen manifests.

## 9. Finish configuration and sign in

1. If the Pages URL differs from the `ALLOWED_ORIGIN` you set in step 3, fix it and redeploy the Worker (`npx wrangler deploy`). A mismatch shows up as CORS errors or a failed login redirect.
2. Open your Pages URL and sign in with Google. You should land in the app.
3. In **Settings → Storage Backends**, add an `r2-bound` backend pointing at your bucket. This is where load jobs and transforms write.
4. Try it: put a file in the bucket and query it, as described in the [README](../README.md#connecting-data-sources).

### Connect Claude (optional)

Add `https://<your-worker-url>/mcp` as a custom connector in Claude and sign in with the same Google account. See [Using it from Claude](../README.md#using-it-from-claude-mcp).

## 10. Optional extras

- **Manage it as code.** Install the `dshack` CLI (see [`cli/README.md`](../cli/README.md)), run `dshack auth login https://<your-worker-url>` and `dshack init https://<your-worker-url>` to keep credentials, jobs, transforms and dashboards as YAML in a repository.
- **Deploy from GitHub Actions.** `.github/workflows/deploy.yml` builds and deploys the Worker and Pages site on manual dispatch. It targets the author's resource names (`data-shack-db`, Pages project `data-shack`), so edit those first. It needs the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the variable `VITE_WORKER_URL` on a GitHub environment named for the target.
- **Custom domains.** Attach them in the Cloudflare dashboard to the Worker and the Pages project, then update `ALLOWED_ORIGIN`, the Google redirect URI and `VITE_WORKER_URL` to match, rebuild the frontend and redeploy.
- **Dev-token auth (local only).** For local development you can skip Google login with `ENABLE_DEV_AUTH`; see the README's [running locally](../README.md#running-locally) section. Do not enable it on a deployed instance.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Google shows `redirect_uri_mismatch` | The redirect URI in step 4 does not exactly match `https://<worker-url>/oauth/callback`. |
| Login completes but the callback returns 403 | Your email is not in `allowed_emails` (step 6), or Google did not return a verified email. |
| Browser CORS errors on every request | `ALLOWED_ORIGIN` does not match the Pages origin. Fix it and redeploy the Worker. |
| Frontend calls the wrong server | `VITE_WORKER_URL` was missing or wrong at build time; rebuild and redeploy Pages. |
| `D1_ERROR: no such table` | Migrations were applied locally but not remotely; run step 5's `--remote` command. |
| Saved credentials stop working after a redeploy | `JWT_SECRET` changed. Restore the old value, or re-enter the credentials. |
| Load jobs never run | Check the queue name matches in both producer and consumer blocks and that the Worker was redeployed after editing `wrangler.toml`. |
