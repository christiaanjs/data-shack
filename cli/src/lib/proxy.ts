import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Node's built-in fetch ignores HTTPS_PROXY/HTTP_PROXY/NO_PROXY. Route it
 * through the proxy when one is configured (sandboxes, corporate networks).
 */
export function enableEnvProxy(): void {
  const e = process.env;
  if (e.NODE_USE_ENV_PROXY) return; // Node already handles it natively
  if (e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}
