import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs once per test file. applyD1Migrations is idempotent — safe to call multiple times.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
