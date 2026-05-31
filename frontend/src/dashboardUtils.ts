export function extractTableName(sql: string): string | null {
  if (/\bJOIN\b/i.test(sql)) return null;
  const froms = [...sql.matchAll(/\bFROM\b/gi)];
  if (froms.length !== 1) return null;
  return /\bFROM\s+["'`]?(\w+)["'`]?/i.exec(sql)?.[1] ?? null;
}

export function parseJsonColumnar(text: string): { columns: string[]; rows: unknown[][] } {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], rows: [] };

  let records: Record<string, unknown>[];
  if (trimmed.startsWith("[")) {
    records = JSON.parse(trimmed) as Record<string, unknown>[];
  } else {
    records = trimmed
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  if (records.length === 0) return { columns: [], rows: [] };
  const columns = Object.keys(records[0]);
  const rows = records.map((rec) => columns.map((col) => rec[col]));
  return { columns, rows };
}

export async function runProxyQuery(
  sql: string,
  workerBase: string,
  getAuthHeaders: () => Promise<Record<string, string>>,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const tableName = extractTableName(sql);
  if (!tableName) {
    const isComplex = /\bJOIN\b/i.test(sql) || (sql.match(/\bFROM\b/gi)?.length ?? 0) !== 1;
    throw new Error(
      isComplex
        ? "Proxy mode supports single-table queries only — enable DuckDB for JOINs and complex queries"
        : `Cannot extract table name from query: ${sql}`,
    );
  }
  const headers = await getAuthHeaders();
  const res = await fetch(`${workerBase}/api/table-data/${encodeURIComponent(tableName)}`, {
    headers,
  });
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Failed to load table data (${res.status})`);
  }
  const text = await res.text();
  return parseJsonColumnar(text);
}

export function buildIframeHtml(
  artifactSource: string,
  results: { columns: string[]; rows: unknown[][] }[],
): string {
  // Convert columnar results to arrays of row objects for ergonomic use in artifacts.
  const rowObjects = results.map(({ columns, rows }) =>
    rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]]))),
  );
  // JSON.stringify gives a safe JS string literal; additionally escape </script so the
  // HTML parser doesn't terminate the enclosing <script> tag prematurely.
  const safeData = JSON.stringify(rowObjects).replace(/<\/script/gi, "<\\/script");
  const safeSource = JSON.stringify(artifactSource).replace(/<\/script/gi, "<\\/script");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>* { box-sizing: border-box; } body { margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }</style>
<script type="importmap">
{"imports":{"react":"https://esm.sh/react@18.3.1","react/jsx-runtime":"https://esm.sh/react@18.3.1/jsx-runtime","react-dom":"https://esm.sh/react-dom@18.3.1","react-dom/client":"https://esm.sh/react-dom@18.3.1/client","recharts":"https://esm.sh/recharts@2.13.3"}}
<\/script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"><\/script>
</head>
<body>
<div id="root"></div>
<script>window.__DATA__ = ${safeData};<\/script>
<script type="module">
const source = ${safeSource};
let code;
try {
  ({ code } = Babel.transform(source, {
    filename: "dashboard.jsx",
    presets: [["react", { runtime: "automatic" }]],
  }));
} catch (err) {
  document.getElementById("root").innerHTML =
    '<pre style="color:red;white-space:pre-wrap;padding:8px">Babel error: ' + err + '</pre>';
  throw err;
}
const blob = new Blob([code], { type: "text/javascript" });
const url = URL.createObjectURL(blob);
try {
  const { default: Dashboard } = await import(url);
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  createRoot(document.getElementById("root")).render(createElement(Dashboard, { data: window.__DATA__ }));
} catch (err) {
  document.getElementById("root").innerHTML =
    '<pre style="color:red;white-space:pre-wrap;padding:8px">Render error: ' + err + '</pre>';
} finally {
  URL.revokeObjectURL(url);
}
<\/script>
</body>
</html>`;
}
