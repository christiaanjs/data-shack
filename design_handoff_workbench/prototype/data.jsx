/* ============================================================================
   Data Shack Workbench — sample warehouse data
   Cosmetic fixtures (no network). NZ personal-finance flavour, consistent with
   the base UI kit. Everything data-shaped is plausible-real, never foo/bar.
   Exported to window for the Babel-scoped component files.
   ============================================================================ */

// Each table carries enough to render a real detail view: inferred schema
// (DESCRIBE), snapshot timeline, row-count estimate, storage size.
const WB_TABLES = [
  {
    name: "transactions",
    backend: "primary-r2",
    format: "parquet",
    uri: "r2://data-shack-storage/transactions/2026-05.parquet",
    rows: 48213, bytes: 6815744, partitions: 5,
    schema: [
      ["id", "VARCHAR"], ["account_id", "VARCHAR"], ["merchant", "VARCHAR"],
      ["category", "VARCHAR"], ["amount", "DECIMAL(10,2)"], ["direction", "VARCHAR"],
      ["posted_at", "DATE"], ["created_at", "TIMESTAMP"],
    ],
    snapshots: [
      { id: "snap_5e21", msg: "May load — Akahu sync", uri: "transactions/2026-05.parquet", rows: 48213, when: "12m ago", current: true },
      { id: "snap_5d04", msg: "April compaction", uri: "transactions/2026-04.parquet", rows: 44120, when: "8d ago" },
      { id: "snap_5c91", msg: "March load", uri: "transactions/2026-03.parquet", rows: 41880, when: "38d ago" },
      { id: "snap_5b30", msg: "initial load", uri: "transactions/2026-q1.parquet", rows: 119500, when: "70d ago" },
    ],
    sample: [
      ["txn_8821", "acc_chq", "Countdown", "Groceries", "42.10", "debit", "2026-05-21"],
      ["txn_8822", "acc_chq", "Z Energy", "Transport", "88.00", "debit", "2026-05-22"],
      ["txn_8823", "acc_cc", "Spotify", "Subscriptions", "14.99", "debit", null],
      ["txn_8824", "acc_chq", "Mitre 10", "Home", "230.45", "debit", "2026-05-24"],
      ["txn_8825", "acc_chq", "Wellington City Council", "Utilities", "119.30", "debit", "2026-05-25"],
      ["txn_8826", "acc_cc", "Moore Wilson's", "Groceries", "61.80", "debit", "2026-05-26"],
      ["txn_8827", "acc_chq", "Salary — Trade Me", "Income", "4120.00", "credit", "2026-05-27"],
    ],
  },
  {
    name: "budget",
    backend: "google-sheets",
    format: "json (auto)",
    uri: "http-ds://google-sheets/Budget2026",
    rows: 38, bytes: 12288, partitions: 1,
    schema: [
      ["category", "VARCHAR"], ["monthly_limit", "DECIMAL(10,2)"],
      ["rollover", "BOOLEAN"], ["notes", "VARCHAR"],
    ],
    snapshots: [
      { id: "snap_bg12", msg: "synced from sheet", uri: "Budget2026!A1:D39", rows: 38, when: "6h ago", current: true },
      { id: "snap_bg11", msg: "synced from sheet", uri: "Budget2026!A1:D39", rows: 37, when: "1d ago" },
    ],
    sample: [
      ["Groceries", "650.00", "false", "incl. household"],
      ["Transport", "320.00", "true", "fuel + PT"],
      ["Subscriptions", "90.00", "false", null],
      ["Utilities", "280.00", "true", "power + water + internet"],
      ["Home", "200.00", "true", "maintenance buffer"],
    ],
  },
  {
    name: "accounts",
    backend: "akahu",
    format: "json (auto)",
    uri: "http-ds://akahu/accounts",
    failed: true,
    rows: null, bytes: null, partitions: 0,
    schema: [],
    snapshots: [],
    sample: [],
  },
  {
    name: "monthly_spending",
    backend: "primary-r2",
    format: "parquet",
    uri: "r2://data-shack-storage/monthly_spending/latest.parquet",
    rows: 144, bytes: 24576, partitions: 1, derived: "monthly_rollup",
    schema: [
      ["month", "DATE"], ["category", "VARCHAR"], ["spent", "DECIMAL(10,2)"],
      ["budget", "DECIMAL(10,2)"], ["delta", "DECIMAL(10,2)"],
    ],
    snapshots: [
      { id: "snap_ms08", msg: "monthly_rollup transform", uri: "monthly_spending/latest.parquet", rows: 144, when: "12m ago", current: true },
      { id: "snap_ms07", msg: "monthly_rollup transform", uri: "monthly_spending/2026-04.parquet", rows: 132, when: "8d ago" },
    ],
    sample: [
      ["2026-05-01", "Groceries", "612.40", "650.00", "-37.60"],
      ["2026-05-01", "Transport", "351.20", "320.00", "31.20"],
      ["2026-05-01", "Subscriptions", "74.97", "90.00", "-15.03"],
      ["2026-05-01", "Utilities", "263.10", "280.00", "-16.90"],
    ],
  },
];

// CodeMirror lang-sql schema: { tableName: [col, col, ...] } → seeds completion.
function wbBuildSchema(tables) {
  const s = {};
  tables.forEach((t) => { if (!t.failed) s[t.name] = t.schema.map((c) => c[0]); });
  return s;
}

const WB_SAVED_QUERIES = [
  { id: "sq_topcat", name: "Top categories this month", sql: "SELECT category, SUM(amount) AS spent\nFROM transactions\nWHERE direction = 'debit'\n  AND posted_at >= DATE '2026-05-01'\nGROUP BY category\nORDER BY spent DESC;" },
  { id: "sq_overbud", name: "Over-budget categories", sql: "SELECT s.category, s.spent, s.budget, s.delta\nFROM monthly_spending s\nWHERE s.delta > 0\nORDER BY s.delta DESC;" },
  { id: "sq_bigtxn", name: "Largest transactions", sql: "SELECT merchant, category, amount, posted_at\nFROM transactions\nORDER BY amount DESC\nLIMIT 25;" },
  { id: "sq_recur", name: "Recurring subscriptions", sql: "SELECT merchant, COUNT(*) AS hits, AVG(amount) AS avg_amount\nFROM transactions\nWHERE category = 'Subscriptions'\nGROUP BY merchant\nHAVING COUNT(*) > 1\nORDER BY hits DESC;" },
];

const WB_TRANSFORMS = [
  {
    id: "tr_comp", name: "compact_transactions", out: "transactions",
    watches: ["transactions"], policy: "any", status: "done", ago: "12m ago",
    sql: "-- Compact incremental loads into a single monthly partition\nCREATE OR REPLACE TABLE transactions AS\nSELECT DISTINCT ON (id) *\nFROM transactions\nORDER BY id, created_at DESC;",
  },
  {
    id: "tr_roll", name: "monthly_rollup", out: "monthly_spending",
    watches: ["transactions", "budget"], policy: "all", status: "idle", ago: "—",
    sql: "-- Roll spend up to month × category and join the budget sheet\nCREATE OR REPLACE TABLE monthly_spending AS\nSELECT\n  date_trunc('month', t.posted_at) AS month,\n  t.category,\n  SUM(t.amount)              AS spent,\n  b.monthly_limit            AS budget,\n  SUM(t.amount) - b.monthly_limit AS delta\nFROM transactions t\nLEFT JOIN budget b ON b.category = t.category\nWHERE t.direction = 'debit'\nGROUP BY 1, 2, b.monthly_limit;",
  },
];

const WB_LOAD_JOBS = [
  { id: "job_tx", table: "transactions", cred: "akahu", path: "/accounts/transactions", backend: "primary-r2", format: "ndjson", cron: "0 * * * *", last: "ok", ago: "12m ago" },
  { id: "job_bg", table: "budget", cred: "google-sheets", path: "Budget2026", backend: "google-sheets", format: "json", cron: "0 6 * * *", last: "ok", ago: "6h ago" },
  { id: "job_fx", table: "fx_rates", cred: "openexchange", path: "/latest.json", backend: "primary-r2", format: "json", cron: "0 0 * * *", last: "fail", ago: "1d ago" },
];

const WB_CREDENTIALS = [
  { id: "cred_ak12x", name: "akahu", type: "http", created: "Apr 12, 2026" },
  { id: "cred_gs88f", name: "google-sheets", type: "google-sheets", created: "Apr 13, 2026" },
  { id: "cred_ox44z", name: "openexchange", type: "http", created: "Apr 20, 2026" },
];
const WB_BACKENDS = [
  { id: "bk_prim01", name: "primary-r2", type: "r2-bound", created: "Apr 10, 2026" },
  { id: "bk_arch02", name: "archive-s3", type: "r2-s3compat", created: "Apr 11, 2026" },
  { id: "bk_sheet3", name: "google-sheets", type: "google-sheets", created: "Apr 13, 2026" },
];
const WB_DASHBOARDS = [
  { id: "dash_x9f2", title: "Monthly Spending", slug: "monthly-spending", created: "May 2, 2026" },
  { id: "dash_k1a7", title: "Cashflow", slug: "cashflow", created: "Apr 28, 2026" },
];

// Format helpers
function wbFmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function wbFmtNum(n) { return n == null ? "—" : n.toLocaleString("en-US"); }

// Build a canned result for an arbitrary SQL string against the catalog.
// Cosmetic: picks the first table named in the query and returns its sample.
function wbRunQuery(sql, tables) {
  const lower = (sql || "").toLowerCase();
  const hit = tables.find((t) => !t.failed && new RegExp(`\\b${t.name}\\b`).test(lower));
  if (/\baccounts\b/.test(lower)) {
    return { error: "Binder Error: table \"accounts\" does not exist — latest snapshot file not found in storage." };
  }
  if (!hit) {
    return { columns: ["?column?"], rows: [["(no catalog table referenced)"]] };
  }
  // Aggregations get a small shaped result; otherwise echo the sample.
  if (/\bgroup by\b/.test(lower) && hit.name === "transactions") {
    return {
      columns: ["category", "spent"],
      rows: [["Income", "4120.00"], ["Home", "230.45"], ["Utilities", "119.30"], ["Transport", "88.00"], ["Groceries", "103.90"], ["Subscriptions", "14.99"]],
    };
  }
  const cols = hit.schema.map((c) => c[0]);
  return { columns: cols, rows: hit.sample.map((r) => r.slice(0, cols.length)) };
}

Object.assign(window, {
  WB_TABLES, WB_SAVED_QUERIES, WB_TRANSFORMS, WB_LOAD_JOBS,
  WB_CREDENTIALS, WB_BACKENDS, WB_DASHBOARDS,
  wbBuildSchema, wbFmtBytes, wbFmtNum, wbRunQuery,
});
