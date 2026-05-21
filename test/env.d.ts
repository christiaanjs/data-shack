declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    R2: R2Bucket;
    CATALOG: DurableObjectNamespace;
    LOAD_JOB_QUEUE: Queue<{ jobId: string }>;
    DEV_TOKEN: string;
    DEV_USER_ID: string;
    ENABLE_OAUTH: string;
    ENABLE_DEV_AUTH: string;
    JWT_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    ALLOWED_ORIGIN: string;
    ALLOW_ORIGIN_SUBDOMAINS: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
