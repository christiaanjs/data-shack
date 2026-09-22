# Oracle Cloud Always Free deployment

Provisions one `VM.Standard.A1.Flex` Always Free instance running the
session container as a `systemd` service, built from this repo directly on
the VM (no container registry needed).

## Prerequisites

1. An Oracle Cloud account (free sign-up; a credit card is required for
   identity verification but Always Free resources aren't charged unless you
   explicitly upgrade — see `../README.md` for current limits/caveats).
2. [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5.
3. An OCI API signing key: Console → Profile → **My Profile** → **API Keys**
   → **Add API Key**. This gives you the fingerprint and a private key file
   for `terraform.tfvars`.
4. Your Worker already deployed (`../../CLAUDE.md`'s bootstrap steps at the
   repo root). For `AUTH_MODE=dev-token`, the production Worker needs
   `ENABLE_DEV_AUTH` enabled (it's off by default in production — only
   `.dev.vars` sets it locally) plus a dedicated `DEV_TOKEN`/`DEV_USER_ID`
   pair:
   ```bash
   # from the repo root — add ENABLE_DEV_AUTH = "true" under the root [vars]
   # table in wrangler.toml (same style as the existing ENABLE_OAUTH line),
   # then redeploy, then set the two secrets:
   npm run deploy
   wrangler secret put DEV_TOKEN
   wrangler secret put DEV_USER_ID   # an existing row's id in the `users` D1 table — see src/db/queries.ts
   ```
   `DEV_TOKEN` should be a value generated specifically for this container
   (e.g. `openssl rand -hex 32`), not reused from local dev.

## Deploy

```bash
cd container/deploy/oracle-always-free
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

terraform init
terraform plan
terraform apply
```

On success:

```
instance_public_ip = "..."
ssh_command = "ssh ubuntu@..."
```

`cloud-init` installs Docker, clones the repo, builds `container/`'s image,
and starts it as `data-shack-session.service` (`Restart=always` — survives
crashes and reboots). Cloud-init can take a few minutes after the instance
is `RUNNING`; check progress with:

```bash
ssh ubuntu@<ip> 'sudo journalctl -u data-shack-session -f'
```

## `AUTH_MODE=oauth-refresh` extra step

Terraform deliberately does **not** carry the OAuth credential file (it's a
live secret that rotates on every token refresh — baking it into Terraform
state/`user_data` would drift immediately). Instead:

```bash
# once, locally:
WORKER_URL=https://your-worker.example.workers.dev npm run login   # from container/

# then, after terraform apply:
terraform output -raw scp_credentials_command | bash
```

If you ever need to re-run `npm run login` (e.g. the refresh token was
revoked), repeat the `scp` step and restart the service the same way.

## Updating

```bash
ssh ubuntu@<ip>
cd /opt/data-shack/src && sudo git pull
cd container && sudo docker build -t data-shack-session-client .
sudo systemctl restart data-shack-session
```

## Teardown

```bash
terraform destroy
```

Also revoke the `DEV_TOKEN` secret (or re-run the interactive login to
invalidate the old refresh token) if you're decommissioning this container
rather than just moving it.
