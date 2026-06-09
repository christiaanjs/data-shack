# Workbench — Remaining Implementation Items

Current state: the workbench shell at `/workbench` is structurally complete (layout, auth, catalog
plumbing, CodeMirror editor, SQL REPL tabs, table detail, welcome screen, commit form, console
dock, command palette, explorer tree). The items below are what is still missing or only partially
done compared to the prototype and README spec.

---

## 1. Icon library (`lucide-preact`)

**Status:** All icons are hand-rolled inline SVGs copied from Lucide paths. This means the icon set
is incomplete and hard to maintain.

**Work:**
- Install `lucide-preact` as a real dependency: `cd frontend && npm i lucide-preact`
- Replace the inline `*Icon` functions in `WorkbenchShell.tsx`, `Explorer.tsx`,
  `CommandPalette.tsx`, `ConsoleDock.tsx`, and `TabViews.tsx` with imports from `lucide-preact`
  (e.g. `import { Files, Search, Plus, X, Database, Settings } from "lucide-preact"`)
- The prototype's icon name map is in `prototype/lib.jsx` (`ICONS` object) — use it as the
  definitive mapping. Stroke width should be `1.6` to match the hairline aesthetic.
- Flag: this changes the product's current zero-icon-library stance; maintainer sign-off needed.

---

## 2. Status bar (`wb-statusbar`)

**Status:** The status bar element exists in `WorkbenchShell.tsx` but is incomplete.

**Missing:**
- **Live clock** — should update every 30 s via `setInterval`; currently static or absent.
- **Queries-run count** — the prototype shows `{history.length} queries run` (mono). Wire to the
  `history` state array that already exists.
- **Table count** — show `{catalogTables.length} tables` (mono). The data is available.
- **Session status text** — currently only a dot; should also show text: `"DuckDB-WASM · connected"
  / "connecting…" / "session off"` next to the dot.
- **User ID** — should appear in the status bar (mono, right side), not just the title bar.

---

## 3. Activity rail — Settings button wires to nothing

**Status:** The Settings icon button in the activity rail calls `() => {}` (no-op).

**Work:** Wire it to open a backend/settings detail tab (e.g. `ctx.openTab("backend", backends[0])`
or navigate to `/settings`). The prototype opens the first backend detail as a demo.

---

## 4. Explorer — active node highlight

**Status:** The explorer passes `activeKey` down but the `active` prop on nodes is derived from
`tab.key` which may not match the node's key format consistently.

**Work:**
- Verify that `openTab` sets `tab.key` using the exact pattern each node type expects
  (`table:name`, `transform:id`, `saved:id`, `job:id`, `dashboard:id`, `cred:id`, `backend:id`).
- Ensure `activeKey` (derived as `activeTab?.key ?? null`) is passed correctly to Explorer from
  WorkbenchShell. Audit mismatches.

---

## 5. Explorer — Load Jobs group `+` add button

**Status:** The `+` on the Load Jobs tree group is present but opens no tab (the `onAdd` handler is
missing or calls a stub).

**Work:** Wire `onAdd={() => ctx.openTab("job", null)}` to open a "New load job" tab (kind=`job`,
`item=null`) that renders `JobView` in new-item mode.

---

## 6. Full detail views for non-table tab kinds

**Status:** `TabContent` routes `transform`, `dashboard`, `job`, `cred`, `backend` to a single
`GenericView` stub that shows only a kicker + title with no real content.

**Work:** Implement each view as a proper detail doc matching the prototype's `views.jsx`:

### 6a. `TransformView`
- Toolbar: transform icon kicker, name (editable if new), `→ output` label, output table tag,
  **Dry run** (ghost) + **Save/Create** (primary) buttons.
- Config strip: watches as outline badges, trigger policy badge, status text + last-run time.
- Replace the existing `TransformJobsPanel` textarea with `<SqlEditor>` (CodeMirror).
- Result split: editor on top, `ResultGrid` below.
- Wire Dry run to `ctx.execute(sql, { source: name })`.
- Wire Save/Create to `PATCH /api/transform-jobs/:id` or `POST /api/transform-jobs`.

### 6b. `DashboardView`
- `DocHead`: kicker "Dashboard artifact", title, `/d/<slug>` sub, Refresh action button.
- Render the existing sandboxed Recharts iframe (reuse the iframe viewer already in
  `DashboardsPanel.tsx`) rather than the static bar chart stub in the prototype.
- Wire to `GET /api/dashboards/:id` for the artifact and bound query data.

### 6c. `JobView`
- `DocHead`: kicker "Load job", title = output table, source sub, Edit + **Run now** actions.
- Show error alert if last run failed.
- Config table: output table, credential, source path, backend, format, schedule (cron).
- Recent runs section: timeline of last N runs with status dot + description + relative time.
- Wire **Run now** to `POST /api/load-jobs/:id/trigger`.

### 6d. `SettingsView` (credentials + storage backends)
- `DocHead`: kicker "Credential" or "Storage backend", name, encrypted-at-rest sub.
- Actions: **Test connection** for credentials; **Edit** for backends (opens the existing
  `EditBackendDialog` from `SettingsPanel.tsx`).
- Detail table: ID, name, type, created, Secret (write-only masked row).
- Wire to `GET /api/credentials/:id` and `GET /api/storage-backends/:id`.

---

## 7. Table detail view — full spec

**Status:** `TableDetailView` exists but only shows a stat row and a single "Latest snapshot"
section. The prototype has significantly more.

**Missing:**
- **Schema section** — run `DESCRIBE <tableName>` via `ctx.execute` when the view mounts and
  render a table of `# / column / type-tag / null?`. Currently absent.
- **Full snapshot timeline** — show all snapshots (not just the latest), with indigo dot + rail,
  URI, rows, relative time, and a `current` pill on the head snapshot. Currently only latest shown.
- **Preview section** — run `SELECT * FROM <table> LIMIT 10` and render a `table-zebra` grid.
  Currently absent.
- **Failed table state** — when `latestSnapshot` is null, show the amber alert variant from the
  prototype ("Re-run its load job or re-commit a snapshot.") with a stat row showing backend and
  format. The current implementation shows a minimal error message without the full layout.
- **"Query table" button** — `DocHead` actions should include a **Query table** primary button that
  opens `SELECT * FROM <name> LIMIT 100;` in a new SQL tab. Currently only a Refresh ghost button
  exists.

---

## 8. Commit snapshot form — format selector and URI hints

**Status:** `CommitView` has table name and URI inputs but is missing:

**Missing:**
- **Format selector** — `<select>` with options: Auto (infer from URI), parquet, ndjson, csv.
  Wire to the `POST /commit` payload.
- **URI hint block** — the three `<p>` examples from the prototype (`r2://`, `r2-s3compat://`,
  `http-ds://`) with inline `<code>` formatting.
- **Wire to actual API** — currently `CommitView` calls `ctx.commitTable` which only updates local
  state. It should also call `POST /api/snapshots` (or whatever the real commit endpoint is) to
  actually persist the snapshot.

---

## 9. Saved queries — load from and persist to D1

**Status:** The `saved_queries` D1 table and API endpoints (`GET/POST/DELETE /api/saved-queries`)
exist. But `WorkbenchShell.tsx` initialises `savedQueries` to `[]` and never fetches from the API.
The `saveQuery` callback only pushes to local state.

**Work:**
- On auth, `GET /api/saved-queries` and populate `savedQueries` state.
- `saveQuery(name, sql, tabId)` should `POST /api/saved-queries` and add the returned item to state.
- Add a delete action in the Explorer saved-query nodes that calls `DELETE /api/saved-queries/:id`.

---

## 10. Explorer — external data lists populated from API

**Status:** `transforms`, `jobs`, `dashboards`, `credentials`, `backends` are all initialised to
`[]` in `WorkbenchShell` and never fetched.

**Work:** After auth, fetch each list in parallel:
- `GET /api/transform-jobs` → `setTransforms`
- `GET /api/load-jobs` → `setJobs`
- `GET /api/dashboards` → `setDashboards`
- `GET /api/credentials` → `setCredentials`
- `GET /api/storage-backends` → `setBackends`

Refresh individual lists after mutations (e.g. after saving a transform, re-fetch transforms).

---

## 11. Middle-click tab close

**Status:** The prototype's `TabStrip` handles `onAuxClick` (mouse button 1 = middle click) to
close a tab. The current implementation only has the ✕ button.

**Work:** Add `onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }}` to each tab `button`
in the tab strip inside `WorkbenchShell.tsx`.

---

## 12. Command palette — `ctx.openPalette` missing from `WbCtx`

**Status:** `WelcomeView` calls `ctx.openPalette()` to open the command palette from the welcome
screen card. Check `workbench-types.ts` — if `openPalette` is missing from the `WbCtx` type and
not passed from `WorkbenchShell`, the welcome screen card will fail or the button will be a no-op.

**Work:** Ensure `openPalette: () => void` is declared in `WbCtx` in `workbench-types.ts` and is
passed from `WorkbenchShell.tsx` in the `ctx` object.

---

## 13. Explorer — `new-transform` and `new-job` stubs in `openTab`

**Status:** The `openTab` callback in `WorkbenchShell` handles `"commit"` and object kinds but
may not handle `"new-transform"` (kind=`transform`, item=null) or `"new-job"` (kind=`job`,
item=null) paths from the Explorer `+` buttons.

**Work:** Ensure `openTab("transform", null)` creates a tab with `kind="transform"`, `item=null`,
`title="New transform"` and a unique key so multiple new-transform drafts don't collide.
Same for `"job"`. `TransformView` and `JobView` should already render in "blank" mode when
`item` is null (per the prototype).

---

## 14. Theme toggle persisted to `document.documentElement.dataset.theme`

**Status:** `WorkbenchShell` applies `document.documentElement.dataset.theme = theme` in a
`useEffect`. However the legacy `LegacyApp` also uses daisyUI's default theme system. If a user
switches between `/` and `/workbench`, there could be a theme conflict.

**Work:** Ensure the workbench theme toggle writes to the same `localStorage` key that daisyUI
reads (or use the same key and sync them). The workbench currently uses `"wb_theme"` while daisyUI
may use a different key. Decide on one source of truth.

---

## 15. Console dock — session-off REPL input disabled state

**Status:** The REPL input in `ConsoleDock` should be visually disabled (grayed, pointer-events
none) and show a hint when `ctx.session.enabled` is false.

**Work:** Pass `session` through `WbCtx` (it's already in the type) and gate the input:
```tsx
<input disabled={!ctx.session.enabled} placeholder={ctx.session.enabled ? "dshk>" : "Enable DuckDB to run queries"} … />
```

---

## 16. CSS — missing or incomplete `wb-*` classes

Some layout classes referenced in the TSX files may not be fully defined in `workbench.css`.
Audit the following and fill gaps:

- `.wb-doc`, `.wb-doc-head`, `.wb-doc-titlewrap`, `.wb-doc-kicker`, `.wb-doc-title`,
  `.wb-doc-sub`, `.wb-doc-actions`
- `.wb-stat-row`, `.wb-stat`, `.wb-stat-label`, `.wb-stat-value`, `.wb-stat-value.sm`
- `.wb-section`, `.wb-section-title`, `.wb-count`, `.wb-panel`
- `.wb-timeline`, `.wb-tl-row`, `.wb-tl-rail`, `.wb-tl-dot`, `.wb-tl-msg`, `.wb-tl-uri`,
  `.wb-tl-meta`, `.wb-tl-current`
- `.wb-form-grid`, `.wb-tag`, `.wb-tag-type`, `.wb-coltype`
- `.wb-welcome`, `.wb-welcome-mark`, `.wb-welcome-actions`, `.wb-welcome-row`, `.wb-wr-ico`,
  `.wb-wr-main`, `.wb-wr-title`, `.wb-wr-sub`
- `.wb-con-hint`, `.wb-empty-inline`, `.wb-null`
- `.ds-status`, `.ds-status-idle`, `.ds-status-done`, `.ds-status-failed`, `.ds-status-running`
- `.dot`, `.dot-success`, `.dot-warning`, `.dot-idle`
- `.wb-group-head.open .wb-chev` (chevron rotation on expand)
- `.wb-node-col` (column sub-row in table node)

Reference `prototype/workbench.css` for the exact values for each class. Many of these exist in
the prototype CSS and need to be ported to the real `workbench.css`.

---

## Priority order

1. **16** (CSS gaps) — unblocks visual correctness everywhere; do first.
2. **2** (status bar) — high visibility, low complexity.
3. **9** (saved queries API) — core persistence feature; the API already exists.
4. **10** (external data lists) — explorer shows empty groups without this.
5. **7** (table detail full spec) — schema + preview are the most-used detail views.
6. **6a** (TransformView) — replaces the existing textarea; big UX improvement.
7. **6c / 6d** (JobView / SettingsView) — replaces GenericView stubs.
8. **6b** (DashboardView) — reuses existing iframe viewer, mostly wiring.
9. **8** (commit form) — format selector + real API call.
10. **1** (lucide-preact) — quality-of-life; needs maintainer sign-off on the new dependency.
11. **3, 11–15** — smaller polish items; can be bundled.
