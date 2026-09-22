import { OAuthRefreshTokenProvider } from "./auth/oauthTokenProvider.js";
import { PatTokenProvider } from "./auth/patTokenProvider.js";
import { DevTokenProvider } from "./auth/tokenProvider.js";
import type { TokenProvider } from "./auth/tokenProvider.js";
import { connectCatalogWs } from "./catalog/ws.js";
import { loadConfig } from "./config.js";
import { DuckDBEngine } from "./duckdb/engine.js";
import { createLogger } from "./logger.js";
import { connectSession } from "./session/ws.js";

const logger = createLogger("main");

function buildTokenProvider(config: ReturnType<typeof loadConfig>): TokenProvider {
  if (config.authMode === "dev-token") {
    // config.devToken is guaranteed set by loadConfig() when authMode is "dev-token".
    return new DevTokenProvider(config.devToken as string);
  }
  if (config.authMode === "token") {
    // config.patToken is guaranteed set by loadConfig() when authMode is "token".
    return new PatTokenProvider(config.patToken as string);
  }
  return new OAuthRefreshTokenProvider(config.workerBase, config.credentialsPath);
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(`starting — worker=${config.workerBase} authMode=${config.authMode}`);

  const tokenProvider = buildTokenProvider(config);

  const engine = new DuckDBEngine(config.duckdbPath, config.duckdbExtensionDir);
  await engine.init();

  let getCatalogReady: () => Promise<void> = () => Promise.resolve();

  if (config.enableCatalogViews) {
    const catalog = connectCatalogWs({
      workerBase: config.workerBase,
      tokenProvider,
      engine,
      onCommit: (event) => logger.info(`catalog commit: ${event.table}`),
    });
    getCatalogReady = () => catalog.getCatalogReady();
  } else {
    logger.info("catalog view registration disabled (ENABLE_CATALOG_VIEWS=false)");
  }

  const session = connectSession({
    workerBase: config.workerBase,
    tokenProvider,
    engine,
    getCatalogReady,
  });

  const shutdown = (signal: string) => {
    logger.info(`received ${signal}, shutting down`);
    session.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal startup error", err);
  process.exit(1);
});
