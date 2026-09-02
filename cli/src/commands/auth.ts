import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";
import pc from "picocolors";
import { clearAuth, loadAuth, saveAuth } from "../lib/auth.js";

const CALLBACK_PORT = 8899;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

export async function authLogin(workerUrl: string): Promise<void> {
  const base = workerUrl.replace(/\/$/, "");

  // 1. Dynamic Client Registration
  process.stdout.write("Registering client... ");
  const regRes = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK_URL] }),
  });
  if (!regRes.ok) {
    const body = await regRes.text().catch(() => "");
    console.error(pc.red(`\nDCR failed (${regRes.status}): ${body}`));
    console.error(pc.dim("Is ENABLE_OAUTH=true set on the worker?"));
    process.exit(1);
  }
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };
  console.log(pc.green("done"));

  // 2. PKCE
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  // 3. Wait for callback via local server
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const cbState = url.searchParams.get("state");
      const cbCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          "<html><body><h2>Authentication complete — you may close this tab.</h2></body></html>",
        );
      server.close();

      if (error) return reject(new Error(`OAuth error: ${error}`));
      if (cbState !== state) return reject(new Error("State mismatch"));
      if (!cbCode) return reject(new Error("No code in callback"));
      resolve(cbCode);
    });
    server.listen(CALLBACK_PORT);
    server.on("error", reject);

    const authUrl = new URL(`${base}/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", CALLBACK_URL);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    console.log(`\nOpening browser: ${pc.cyan(authUrl.toString())}\n`);
    openBrowser(authUrl.toString());
    console.log(pc.dim("Waiting for OAuth callback on localhost:8899 …"));
  });

  // 4. Exchange code for tokens
  process.stdout.write("Exchanging code... ");
  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK_URL,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    console.error(pc.red(`\nToken exchange failed (${tokenRes.status}): ${body}`));
    process.exit(1);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  console.log(pc.green("done"));

  saveAuth({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    worker_url: base,
  });
  console.log(pc.green(`\n✓ Authenticated with ${base}`));
}

export function authSetToken(workerUrl: string, token: string): void {
  saveAuth({ access_token: token, worker_url: workerUrl.replace(/\/$/, "") });
  console.log(pc.green(`✓ Token saved for ${workerUrl}`));
}

export function authLogout(): void {
  clearAuth();
  console.log(pc.green("✓ Logged out"));
}

export function authStatus(): void {
  const auth = loadAuth();
  if (!auth) {
    console.log(pc.yellow("Not authenticated"));
    return;
  }
  const expired =
    auth.expires_at !== undefined && auth.expires_at < Date.now() ? pc.red(" (expired)") : "";
  console.log(`Worker: ${pc.cyan(auth.worker_url)}${expired}`);
  console.log(`Token:  ${auth.access_token.slice(0, 8)}…`);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(cmd, [url]);
}
