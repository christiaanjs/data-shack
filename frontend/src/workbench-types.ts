import type { CatalogTableWithSnapshot } from "./catalogViews.ts";

export type TabKind =
  | "sql"
  | "table"
  | "transform"
  | "dashboard"
  | "job"
  | "cred"
  | "backend"
  | "commit";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  ms?: number;
  error?: string;
}

export interface WbTab {
  id: string;
  kind: TabKind;
  key: string;
  title: string;
  // biome-ignore lint/suspicious/noExplicitAny: tab item payload varies by kind
  item?: any;
  sql?: string;
  result?: QueryResult | null;
  savedId?: string;
}

export interface LogEntry {
  id: string;
  sql: string;
  source: string;
  ms?: number;
  result?: QueryResult;
  when: string;
}

export interface HistoryEntry {
  sql: string;
  rows: number | null;
  when: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  created_at?: number;
}

export interface WbTransform {
  id: string;
  name: string | null;
  sql: string;
  output_table: string;
  output_uri: string;
  output_backend: string;
  format: string | null;
  status: string;
  last_run_at?: number | null;
  last_completed_at?: number | null;
  last_error?: string | null;
}

export interface WbJob {
  id: string;
  output_table: string | null;
  last_run_at?: number | null;
  last_error?: string | null;
}

export interface WbDashboard {
  id: string;
  title: string;
  slug?: string | null;
}

export interface WbCredential {
  id: string;
  name: string;
  type: string;
}

export interface WbBackend {
  id: string;
  name: string;
  type: string;
}

export interface WbData {
  tables: CatalogTableWithSnapshot[];
  transforms: WbTransform[];
  jobs: WbJob[];
  dashboards: WbDashboard[];
  savedQueries: SavedQuery[];
  credentials: WbCredential[];
  backends: WbBackend[];
}

export interface WbCtx {
  data: WbData;
  schema: Record<string, string[]>;
  session: { enabled: boolean; connected: boolean };
  theme: string;
  execute: (sql: string, opts?: { source?: string }) => Promise<QueryResult>;
  openTab: (kind: string, item?: unknown) => void;
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  setTabSql: (id: string, text: string) => void;
  setTabResult: (id: string, result: QueryResult) => void;
  saveQuery: (name: string, sql: string, tabId: string) => void;
  commitTable: (args: { name: string; uri: string }) => void;
  toggleSession: () => void;
  toggleTheme: () => void;
  toggleDock: () => void;
  openPalette: () => void;
}
