# Data Shack — Workbench UI kit

A **full IDE-style recreation** of the Data Shack web app: a real data
workbench rather than the centered-column proof-of-concept in `../app/`. Built
with React + Babel (in-browser) and the design-system tokens
(`../../colors_and_type.css` + `../../ds-components.css` + `workbench.css`).
Cosmetic — real layout, states, persistence, and a real code editor; fake data,
no network.

## Run it
Open `index.html` → "Sign in with Google" (fake) → the workbench.

## Shell anatomy
- **Title bar** — wordmark, global `⌘K` search/command bar, session status dots,
  DuckDB toggle, theme toggle (light default / dark), user id, sign out.
- **Activity rail** — Explorer · Search · Commit snapshot · Settings.
- **Explorer tree** — every object the warehouse manages: Catalog tables
  (expandable to columns), Transforms, Saved Queries, Load Jobs, Dashboards,
  Credentials, Storage Backends. Click any node to open it as a tab.
- **Editor area** — multi-tab. SQL tabs, table-detail tabs, transform editors,
  dashboard viewer, job/credential/backend detail, commit form. Tabs are
  closeable (✕ or middle-click) and the session is **not** torn down on close.
- **Bottom dock (Console)** — interactive REPL (`dshk>` prompt, `↑/↓` walks
  persisted history, `↵` runs) **plus** an executed-SQL log fed by every query
  run anywhere. A History sub-tab lists recent queries (click to re-open, ▶ to
  re-run). Resizable; `⌘J` toggles.
- **Status bar** — session state, table count, queries-run counter, clock.

## What's interactive
- **Multi-tab REPL** — each SQL tab has its own CodeMirror buffer + result grid;
  all tabs share the same session, catalog schema, and proxy credentials, so
  cross-tab joins "work". `⌘↵` / Run executes; results render in a grid below.
- **CodeMirror 6** — real SQL syntax highlighting + **autocomplete seeded from
  catalog table & column names** (`@codemirror/lang-sql` `schema` option). Token
  colors are driven off the theme tokens, so dark/light switch for free.
- **Query history & bookmarks** — recent queries persist in `localStorage`;
  "Save" turns a buffer into a named saved query (appears in the Explorer and
  `⌘K`). (In the real product these go to a `saved_queries` table in D1.)
- **`⌘K` command palette** — searches saved queries, catalog tables, every
  managed object, open tabs, and global actions (new query, commit, toggle
  DuckDB/console/theme).
- **Catalog detail** — schema (DESCRIBE), snapshot timeline, row-count estimate,
  storage size, preview; "Query table" seeds a new SQL tab.

## Files
| File | Role |
|---|---|
| `index.html` | Loads CodeMirror (esm.sh import map) + React/Babel + all components |
| `cm-setup.js` | ES module: builds the CodeMirror 6 SQL editor factory → `window.DSCodeMirror` |
| `workbench.css` | The entire IDE shell layout + CodeMirror token-color variables |
| `data.jsx` | Sample warehouse data (schemas, snapshots, sizes, saved queries, transforms) |
| `lib.jsx` | Primitives (`Btn`,`Badge`,`Icon`,`SqlEditor`…) + `useLocalStorage` |
| `Explorer.jsx` | Left object tree |
| `views.jsx` | All tab content views + result grid |
| `Console.jsx` | Bottom dock — REPL + log + history |
| `CommandPalette.jsx` | `⌘K` global command bar |
| `App.jsx` | State, tab/session management, layout, mount |

## Fidelity flags (read before shipping)
- **Icons are a substitution.** Data Shack ships **no icon library**. A true IDE
  shell needs them, so this kit uses **Lucide** line-icon paths (in `lib.jsx`,
  embedded as inline SVG so it stays offline). This is the README-sanctioned
  fallback — *it is not part of the actual product* and should be confirmed
  before being treated as canon.
- **CodeMirror loads from `esm.sh` over the network.** If offline / CDN-blocked,
  `SqlEditor` falls back to a styled mono `<textarea>` (still highlightless but
  fully usable) after a short grace period, so the workbench never hard-breaks.
- Everything is cosmetic: results are canned (`wbRunQuery`), no DuckDB-WASM,
  D1, or R2 is actually contacted.
