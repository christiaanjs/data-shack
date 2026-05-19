declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    DEV_TOKEN: string;
    DEV_USER_ID: string;
    ENABLE_OAUTH: string;
    ENABLE_DEV_AUTH: string;
    JWT_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
