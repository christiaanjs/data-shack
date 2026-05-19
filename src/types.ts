export interface User {
  id: string;
  email: string | null;
  created_at: number;
}

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  DEV_TOKEN: string;
  DEV_USER_ID: string;
  ENABLE_OAUTH: string;
  ENABLE_DEV_AUTH: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JWT_SECRET: string;
  ALLOWED_ORIGIN: string;
  ALLOW_ORIGIN_SUBDOMAINS: string;
  DEFAULT_OAUTH_PROVIDER?: string;
}
