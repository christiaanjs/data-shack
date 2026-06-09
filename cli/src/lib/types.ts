export type ResourceKind =
  | "credential"
  | "storage-backend"
  | "load-job"
  | "transform"
  | "saved-query";

export interface CredentialResource {
  kind: "credential";
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface StorageBackendResource {
  kind: "storage-backend";
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface LoadJobResource {
  kind: "load-job";
  name: string;
  credential: string;
  storage_backend: string;
  table_name: string;
  table_path?: string;
  http_path?: string;
  http_method?: string;
  format?: string;
  cron_schedule?: string;
  enabled?: boolean;
  source_type?: string;
  source_config?: Record<string, unknown>;
  pagination_config?: Record<string, unknown>;
  date_range_config?: Record<string, unknown>;
}

export interface TransformTrigger {
  watches: string | string[];
  policy?: "any" | "all";
}

export interface TransformResource {
  kind: "transform";
  name: string;
  output_table: string;
  output_uri: string;
  output_backend?: string;
  format?: string;
  requires_browser?: boolean;
  sql: string;
  triggers?: TransformTrigger[];
}

export interface SavedQueryResource {
  kind: "saved-query";
  name: string;
  sql: string;
}

export type Resource =
  | CredentialResource
  | StorageBackendResource
  | LoadJobResource
  | TransformResource
  | SavedQueryResource;

export interface StateEntry {
  id: string;
  kind: ResourceKind;
  hash: string;
  trigger_ids?: string[];
}

export interface State {
  version: number;
  worker_url: string;
  resources: Record<string, StateEntry>;
}

export interface AuthConfig {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  worker_url: string;
}
