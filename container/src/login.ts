#!/usr/bin/env node
// One-time interactive login: performs the same DCR + PKCE authorization-code
// flow as frontend/src/auth.ts, but catches the redirect on a local HTTP
// server instead of a browser page (this script has no browser context of
// its own — it prints a URL for a human to open). The resulting refresh
// token is written to a JSON file the container reads at startup
// (see src/auth/oauthTokenProvider.ts). Run this on your own machine, NOT
// inside the container — the container only needs the resulting file.
//
// Usage:
//   WORKER_URL=https://data-shack.example.workers.dev npm run login
//   npm run login -- --out ./my-credentials.json --port 8976

import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";

function parseArgs(argv: string[]): { out: string; port: number } {
  let out = "./credentials.json";
  let port = 8976;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) out = argv[++i]!;
    else if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
  }
  return { out, port };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main(): Promise<void> {
  const workerBase = (process.env.WORKER_URL ?? "").replace(/\/+$/, "");
  if (!workerBase) {
    console.error("Set WORKER_URL to the data-shack Worker's base URL, e.g.:");
    console.error("  WORKER_URL=https://data-shack.example.workers.dev npm run login");
    process.exit(1);
  }

  const { out, port } = parseArgs(process.argv.slice(2));
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 1. Dynamic Client Registration — same as frontend/src/auth.ts's ensureClientId().
  const registerRes = await fetch(`${workerBase}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  if (!registerRes.ok) {
    throw new Error(
      `Client registration failed: ${registerRes.status} ${await registerRes.text()}`,
    );
  }
  const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

  // 2. PKCE + state.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authorizeUrl = new URL(`${workerBase}/authorize/google`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);

  // 3. Local server to catch the redirect, then open-code exchange at /token.
  const result = await new Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(`<p>Login failed: ${error}</p>`);
          reject(new Error(`Authorization failed: ${error}`));
          server.close();
          return;
        }

        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (returnedState !== state || !code) {
          res
            .writeHead(400, { "Content-Type": "text/html" })
            .end("<p>State mismatch or missing code.</p>");
          reject(new Error("State mismatch or missing code in callback"));
          server.close();
          return;
        }

        try {
          const params = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            client_id: clientId,
          });
          const tokenRes = await fetch(`${workerBase}/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });
          if (!tokenRes.ok) {
            throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
          }
          const data = (await tokenRes.json()) as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
          };
          res
            .writeHead(200, { "Content-Type": "text/html" })
            .end("<p>Login complete — you can close this window.</p>");
          resolve({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
          });
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" }).end("<p>Token exchange failed.</p>");
          reject(err);
        } finally {
          server.close();
        }
      })();
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Open this URL in a browser to log in:\n\n  ${authorizeUrl.toString()}\n`);
      console.log(`Waiting for the redirect on http://127.0.0.1:${port}/callback ...`);
    });
    server.on("error", reject);
  });

  await writeFile(
    out,
    `${JSON.stringify({ clientId, refreshToken: result.refreshToken }, null, 2)}\n`,
    { mode: 0o600 },
  );

  console.log(`\nSaved refresh-token credential to ${out}`);
  console.log(`Access token (valid ${result.expiresIn}s, not persisted): ${result.accessToken}`);
  console.log(
    `\nMount ${out} into the container at the path given by AUTH_CREDENTIALS_PATH (default /data/credentials.json) with AUTH_MODE=oauth-refresh.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
