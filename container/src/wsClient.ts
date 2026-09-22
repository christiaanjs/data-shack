import WebSocket from "ws";
import type { TokenProvider } from "./auth/tokenProvider.js";
import { createLogger } from "./logger.js";

const PING_INTERVAL_MS = 25_000; // Session DO marks a socket stale after 3 missed pings (75s) — src/session/do.ts.
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export interface PersistentWsHandlers {
  onOpen?: (ws: WebSocket, isReconnect: boolean) => void;
  onMessage: (data: string, ws: WebSocket) => void;
  onClose?: () => void;
}

export interface PersistentWs {
  close(): void;
  isConnected(): boolean;
}

/**
 * A long-lived WebSocket client for a persistent Node process: connects,
 * pings on a fixed interval, and reconnects with exponential backoff on
 * close/error. This intentionally does NOT hibernate or tear itself down
 * between messages — the Session/Catalog DOs on the other end already
 * hibernate on Cloudflare's side (ctx.acceptWebSocket), which is what makes
 * a permanently-open socket from this side cheap for them. A scale-to-zero
 * container platform would instead leave the DO with no live socket to route
 * queries/jobs to whenever this process was asleep, so the container itself
 * must stay up continuously (see container/deploy/README.md).
 */
export function connectPersistentWs(
  urlBase: string,
  path: string,
  tokenProvider: TokenProvider,
  handlers: PersistentWsHandlers,
  scope: string,
): PersistentWs {
  const logger = createLogger(scope);
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let backoffMs = BACKOFF_INITIAL_MS;
  let everConnected = false;

  async function connect(): Promise<void> {
    if (closed) return;

    let token: string;
    try {
      token = await tokenProvider.getWsToken();
    } catch (err) {
      logger.error("failed to obtain auth token, retrying", err);
      scheduleReconnect();
      return;
    }

    const wsBase = urlBase.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsBase}${path}`, [token]);
    ws = socket;

    socket.on("open", () => {
      backoffMs = BACKOFF_INITIAL_MS;
      logger.info("connected");
      handlers.onOpen?.(socket, everConnected);
      everConnected = true;
      pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
    });

    socket.on("message", (data) => {
      handlers.onMessage(data.toString("utf8"), socket);
    });

    socket.on("close", (code, reason) => {
      if (pingInterval !== null) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      ws = null;
      logger.warn(`disconnected (code=${code} reason=${reason.toString() || "none"})`);
      handlers.onClose?.();
      if (!closed) scheduleReconnect();
    });

    socket.on("error", (err) => {
      logger.error("socket error", err);
      socket.close();
    });
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => logger.error("reconnect failed", err));
    }, delay);
  }

  connect().catch((err) => logger.error("initial connect failed", err));

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (pingInterval !== null) clearInterval(pingInterval);
      ws?.close();
    },
    isConnected() {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}
