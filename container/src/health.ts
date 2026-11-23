import { type Server, createServer } from "node:http";
import { createLogger } from "./logger.js";

const logger = createLogger("health");

export interface HealthServer {
  close(): void;
}

/**
 * Minimal inbound HTTP listener — the session client otherwise only makes
 * outbound connections (WS to the Worker). Cloudflare Containers' control
 * plane may poll a port to decide a container has finished starting before
 * `ctx.container.start()` resolves on the Worker side; a bare 200 on every
 * path satisfies that without knowing the exact probe path/method in use.
 * Harmless to run even outside Containers (e.g. a plain VPS) — it's not
 * exposed by the Dockerfile unless the deployment target binds the port.
 */
export function startHealthServer(port: number): HealthServer {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
  });
  server.on("error", (err) => logger.warn("health server error", err));
  server.listen(port, () => logger.info(`health check listening on :${port}`));
  return {
    close() {
      server.close();
    },
  };
}
