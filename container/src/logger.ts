type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env.LOG_LEVEL?.toLowerCase() as Level | undefined) ?? "info";
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

function log(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) out(line, extra);
  else out(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => log("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => log("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => log("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => log("error", scope, message, extra),
  };
}
