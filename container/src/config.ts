export type AuthMode = "dev-token" | "oauth-refresh";

export interface Config {
  /** Base HTTP(S) origin of the data-shack Worker, e.g. https://data-shack.example.workers.dev */
  workerBase: string;
  authMode: AuthMode;
  /** dev-token mode: the shared secret matching the Worker's DEV_TOKEN. */
  devToken?: string;
  /** oauth-refresh mode: path to the JSON credential file produced by `npm run login`. */
  credentialsPath: string;
  /** Whether to also connect to /catalog/ws and register DuckDB views per catalog table. */
  enableCatalogViews: boolean;
  /** DuckDB database file path, or ":memory:" for an ephemeral in-process database. */
  duckdbPath: string;
  /** Fixed extension directory (set by the Docker image at build time so httpfs loads offline). */
  duckdbExtensionDir?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  const workerBase = requireEnv("WORKER_URL").replace(/\/+$/, "");
  const authMode = (process.env.AUTH_MODE ?? "dev-token") as AuthMode;
  if (authMode !== "dev-token" && authMode !== "oauth-refresh") {
    throw new Error(`Invalid AUTH_MODE "${authMode}" — must be "dev-token" or "oauth-refresh"`);
  }

  const devToken = process.env.DEV_TOKEN;
  if (authMode === "dev-token" && !devToken) {
    throw new Error("AUTH_MODE=dev-token requires DEV_TOKEN to be set");
  }

  return {
    workerBase,
    authMode,
    devToken,
    credentialsPath: process.env.AUTH_CREDENTIALS_PATH ?? "/data/credentials.json",
    enableCatalogViews: (process.env.ENABLE_CATALOG_VIEWS ?? "true").toLowerCase() !== "false",
    duckdbPath: process.env.DUCKDB_PATH ?? ":memory:",
    duckdbExtensionDir: process.env.DUCKDB_EXTENSION_DIR,
  };
}
