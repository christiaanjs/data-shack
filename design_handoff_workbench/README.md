# Handoff: Data Shack Workbench (richer frontend)

## How to drive Claude Code with this package

1. Clone the real product repo: `git clone https://github.com/christiaanjs/data-shack`.
2. Drop this whole `design_handoff_workbench/` folder into the repo root (it's
   git-ignored / throwaway — it's reference material, not shipped code).
3. Open Claude Code in the repo and start with a prompt like:

   > Read `design_handoff_workbench/README.md` and open
   > `design_handoff_workbench/prototype/index.html` in a browser to see the
   > target design. We're enriching the existing Preact + daisyUI app in
   > `frontend/src/`. Implement it **incrementally, one feature per PR** in the
   > order listed under "Suggested build order". Start with Phase 1 only and
   > stop for review. Use the existing stack (Preact, Tailwind v4, daisyUI v5,
   > Vite, TypeScript) — do not copy the prototype's React/Babel HTML.

4. Work phase by phase. Each phase below is independently shippable.

**Critical framing:** the files in `prototype/` are a **design reference built
in plain HTML + React-via-Babel**. They show the intended look, layout, and
behavior. They are **not** production code to paste. The job is to recreate
them in the data-shack codebase using its real stack and patterns. Where the
prototype fakes data (`data.jsx`, `wbRunQuery`), the real app already has the
DuckDB-WASM session, the catalog/proxy plumbing, and the MCP/REST API — wire to
those instead.

---

## Overview

The current Data Shack UI is a centered, single-column stack of daisyUI cards
under a tab bar (`App.tsx` + `QueryPanel.tsx`, `CatalogPanel.tsx`, …). This
redesign turns it into a **real data workbench / IDE shell**:

- a left **Explorer** tree of every object the warehouse manages,
- a **multi-tab editor area** (SQL REPL tabs, table-detail tabs, transform
  editors, dashboard viewer, object detail),
- a **bottom Console dock** that is both an interactive SQL REPL and a log of
  every executed query,
- a **⌘K command palette**,
- real **CodeMirror 6** SQL editing with catalog-seeded autocomplete,
- **query history + named bookmarks**.

It deliberately stays inside the existing brand: daisyUI v5 on Tailwind v4,
light default + dark, system fonts, mono for everything data-shaped, rationed
indigo primary, state-color dots, flat surfaces, hairline borders.

## Fidelity

**High-fidelity.** Colors, spacing, type, and interactions are final and should
be reproduced faithfully — but via daisyUI/Tailwind utility classes and the
existing theme tokens, **not** the prototype's bespoke `workbench.css`. The
prototype's CSS is a faithful re-implementation of daisyUI; in the real repo the
same look comes "for free" from daisyUI + the few custom classes noted below.

---

## Stack mapping (prototype → real repo)

| Prototype (reference) | Real codebase target |
|---|---|
| `index.html` + Babel `<script type="text/babel">` | Preact components in `frontend/src/`, built by Vite |
| `App.jsx` | rework of `frontend/src/App.tsx` (shell, routing, session) |
| `lib.jsx` `SqlEditor` + `cm-setup.js` | a real `<SqlEditor>` Preact component importing CodeMirror 6 from npm |
| `data.jsx` + `wbRunQuery` | existing DuckDB-WASM session + catalog/proxy + REST/MCP API |
| `workbench.css` | daisyUI classes + a small `workbench.css`/Tailwind layer for the IDE chrome only |
| Lucide inline SVG in `lib.jsx` | `lucide-preact` (⚠ new dependency — see Assets) |
| `useLocalStorage`, `wb_*` keys | same localStorage approach; bookmarks also persist to **D1** |

---

## Suggested build order (phases)

**Phase 1 — SqlEditor component (CodeMirror 6).** Foundation for everything else.
**Phase 2 — Query REPL with history + bookmarks + ⌘K** (one query tab is fine).
**Phase 3 — IDE shell**: Explorer tree, multi-tab editor area, bottom Console dock.
**Phase 4 — Catalog table detail view** (schema / snapshots / size).
**Phase 5 — Transform editor** swaps its `<textarea>` for `<SqlEditor>`.
**Phase 6 — polish**: dashboard/job/credential/backend detail tabs, status bar.

Phases 1–2 deliver most of the value and can ship before the full shell rewrite.

---

## CodeMirror 6 (Phase 1)

Install as real deps (no esm.sh, no import map — those are prototype-only
workarounds for a no-bundler HTML file):

```
npm i codemirror @codemirror/state @codemirror/view @codemirror/commands \
      @codemirror/language @codemirror/autocomplete @codemirror/lang-sql \
      @lezer/highlight
```

Build a `<SqlEditor>` Preact component. The factory in
`prototype/cm-setup.js` is a near-1:1 blueprint — reuse its extension list,
keymap, and `HighlightStyle`. Key points:

- **Catalog-seeded autocomplete** is the whole point: pass `lang-sql` a `schema`
  object `{ tableName: ["col1","col2", …] }` built from the live catalog
  (`get_warehouse_schema` / the catalog store). `@codemirror/lang-sql` then
  completes table and column names automatically. Reconfigure via a
  `Compartment` when the catalog changes (see `setSchema` in `cm-setup.js`).
- **Theme via CSS variables**, not JS color literals: the prototype's
  `HighlightStyle` uses `color: "var(--cm-keyword)"` etc., and `workbench.css`
  defines `--cm-*` per theme. Carry this over so dark/light switch for free
  with daisyUI's `data-theme`. The token→variable mapping is in
  `prototype/workbench.css` (top block) and `prototype/cm-setup.js`.
- **`Mod-Enter` / `Shift-Enter` = run.** Wire to the panel's execute handler.
- Props: `value, schema, editable, onChange, onRun`; expose `getDoc/setDoc/focus`
  imperatively for the toolbar Run button and "insert column" affordances.

---

## Screens / views

All measurements are from `prototype/workbench.css`; class names there are
descriptive (`.wb-*`). Reproduce the *look* with daisyUI; the `.wb-*` chrome
classes can be ported as a small CSS layer.

### Shell (App.tsx)
- **Title bar** — height 44px, `bg-base-200`, `border-b base-300`. Left:
  wordmark (9px rotated indigo square + "Data Shack" bold, `text-sm`). Center: a
  `⌘K` search button (28px tall, `bg-base-100`, hairline border, mono `⌘K`
  kbd chip). Right group (gap 10px): new-data dot (amber, flashes 3s) + session
  dot (green when connected / `base-content/20` idle), DuckDB `toggle toggle-xs`,
  theme toggle icon button, mono `usr_…` id, sign-out icon button.
- **Activity rail** — width 48px, `bg-base-200`, `border-r`. Icon buttons
  (36px): Explorer (active, 2px indigo left marker), Search→opens ⌘K; spacer;
  Commit snapshot, Settings. ~20px Lucide icons, `base-content/55`, hover full.
- **Explorer sidebar** — resizable (min 190, max 460, default 264px), `bg-base-200`,
  `border-r`. Header row "EXPLORER" (11px, 600, uppercase, `base-content/55`) +
  new-query `+`. See tree spec below.
- **Editor area** — fills remaining width. Tab strip (36px) + scrollable tab
  content.
- **Bottom dock** — resizable (min 120, max 70vh, default 250px), top drag
  handle. Toggle with `⌘J` / status-bar button / dock ✕.
- **Status bar** — height 24px, `bg-base-200`, `border-t`, `text-xs`
  `base-content/58`: session state + dot, table count (mono), queries-run count
  (mono), spacer, Console toggle, user id, clock.

### Explorer tree (Explorer.jsx)
Collapsible groups, each: chevron (rotates 90° open) + group icon + UPPERCASE
label + mono count + optional `+` add. Groups & their open-by-default state:
- **Catalog** (open) — table nodes; mono name, row-count meta on the right,
  expandable chevron reveals `column · TYPE` children. Failed table → idle dot
  instead of count. Click → table-detail tab. `+` → commit-snapshot tab.
- **Transforms** (open) — status dot (green done / idle) + name. Click → editor.
- **Saved Queries** (open) — bookmark icon + name. Click → SQL tab seeded.
- **Load Jobs** — table name + last-run dot. Click → job detail.
- **Dashboards** — title. Click → dashboard viewer.
- **Credentials**, **Storage Backends** — name + type. Click → settings detail.

Node row: 26px min height, mono `text-[12.5px]`, hover `base-content/7`, active
`bg-primary/14` with the icon turning indigo. Active node is derived from the
active tab's key (`table:<name>`, `transform:<id>`, `saved:<id>`, …).

### Tab strip & multi-tab REPL (App.tsx + views.jsx `SqlTabView`)
- Tabs: 36px, `bg-base-200`; active = `bg-base-100` + 2px indigo top border.
  Icon + label (`.sql` suffix on SQL tabs, mono) + ✕ close (also middle-click).
  Trailing `+` opens a new blank query. Tabs are **deduped by key** for object
  tabs (clicking a table twice focuses the existing tab) but **always new** for
  blank queries. **Closing a tab must NOT tear down the DuckDB session.**
- **SQL tab** = toolbar (`Run` primary btn + `⌘↵` kbd, `Save` bookmark btn that
  expands to an inline name field, disabled-session warning, mono filename) over
  a split: `<SqlEditor>` on top, result grid below (`max-height:48%`,
  `border-t`, sticky result bar showing `N rows · M ms · K cols`,
  `table table-sm table-zebra`, mono cells, italic muted `null`, a `#` row-index
  column). Each tab owns its own buffer + result; all share the session,
  catalog schema, and proxy creds (so cross-tab joins work).

### Catalog table detail (views.jsx `TableDetailView`)
- `DocHead`: kicker ("Catalog table" or "Derived · <transform>") + mono title +
  URI subtitle; actions = refresh + **Query table** (seeds `SELECT * FROM t
  LIMIT 100;` in a new SQL tab).
- **Stat row**: Rows (est.), Size (human bytes), Columns, Snapshots, Format —
  grid of `bg-base-100` cells separated by `base-300` hairlines, mono values.
- **Schema** section = "DESCRIBE <t>"; table of `# / column / type-tag / null`.
  In the real app populate from a `DESCRIBE` query against the session.
- **Snapshots** = vertical timeline (indigo dot + connecting rail), message,
  mono URI, rows + relative time, a `current` pill on the latest.
- **Preview** = first N rows (`table-zebra`, mono).
- Failed table → amber `alert` explaining the missing storage object; no schema.

### Transform editor (views.jsx `TransformView`)
Replace `TransformJobsPanel`'s `<textarea>` with `<SqlEditor>`. Toolbar: name,
`→ output` table tag, **Dry run** (ghost) + **Save/Create** (primary). A config
strip shows watches (outline badges), trigger policy badge, status (`ds-status-*`
colored text) + last run. Editor + result split like the SQL tab.

### Dashboard / Job / Credential / Backend detail
Simple detail docs (DocHead + stat/table panels). Dashboard renders the
sandboxed Recharts artifact (the prototype stubs a bar chart — use the real
iframe viewer). Job detail: config table + recent-runs list + Run now. Cred /
backend: detail table with a write-only secret row + Test connection.

### Console dock (Console.jsx)
- Sub-tabs: **Console** (terminal icon) and **History** (with a count badge);
  tools: clear, hide.
- **Console** = scrolling log + a `dshk>` input row. Every executed query
  (from any tab or the REPL) appends an entry: prompt + one-line SQL (+ source
  tag for non-console runs), then a result line `→ N rows · K cols · M ms` (or
  red `✕ <error>`), mono throughout, auto-scroll to bottom.
- **REPL input**: `↵` runs, `↑`/`↓` walk persisted command history, disabled
  when the session is off. All mono.
- **History** tab: recent queries (click row → open in a tab; ▶ → re-run in
  console). Persisted in localStorage in the prototype; see persistence note.

### ⌘K command palette (CommandPalette.jsx)
Centered overlay (max 620px), scrim closes on mousedown. Search input + grouped
results: **Actions** (new query, commit, toggle DuckDB/console/theme), **Saved
queries**, **Tables**, **Transforms**, **Dashboards**, **Load jobs**,
**Credentials**, **Backends**, **Go to tab** (open tabs). `↑/↓` navigate, `↵`
runs, `esc` closes, hover sets active. Active row = `bg-primary` /
`primary-content`. Footer shows nav hints + result count.

---

## Interactions & behavior
- **Session gating**: queries only run when the DuckDB toggle is on; otherwise
  Run is disabled and execute returns an error logged to the console. Toggling
  on "connects" after ~500ms (green dot). Mirrors current `App.tsx` behavior.
- **Commit → new data**: committing a snapshot flashes the amber navbar dot for
  3s and adds/updates the catalog table (existing behavior — keep it).
- **Run**: `⌘↵`/`Shift↵` in any editor, or the Run button. Show inline spinner +
  "Running…", then result grid + console entry.
- **Save bookmark**: inline name field → creates a saved query (Explorer + ⌘K),
  retitles the tab. Persist to D1 (see below).
- **Resizers**: pointer-drag the sidebar (col-resize) and dock (row-resize);
  persist sizes to localStorage.
- **Keyboard**: `⌘K` palette, `⌘J` console, `esc` closes overlays.
- Theme toggle flips `document.documentElement.dataset.theme` and persists.

## State management
Largely lifts to `App.tsx`. Key state: `authed`, `theme`, `session
{enabled, connected}`, `hasNewData`, `tables` (catalog), `savedQueries`, `tabs[]`
+ `activeId`, console `log[]`, `history[]`, `dockOpen/dockTab`, `paletteOpen`,
`sidebarW/dockH`. Tab object: `{ id, kind, key, title, item?, sql?, result? }`.
`kind ∈ {sql, table, transform, dashboard, job, cred, backend, commit}`. See
`prototype/App.jsx` `openTab/closeTab/execute/saveQuery` for exact reducer logic.

### New persistence — `saved_queries` in D1 (per the spec)
- Migration: `saved_queries(id TEXT PK, user_id TEXT, name TEXT, sql TEXT,
  created_at INTEGER)`, scoped to the user namespace like other tables.
- API: `GET /saved-queries`, `POST /saved-queries`, `DELETE /saved-queries/:id`
  (follow the existing catalog/credential endpoint conventions + AES/auth
  middleware). Recent-query *history* can stay localStorage-only, or also back
  to D1 if you want cross-device history — the spec only requires bookmarks in D1.

## Design tokens
Use the existing daisyUI theme — do **not** introduce new colors. Reference
values (from `prototype/colors_and_type.css`, verbatim daisyUI v5 light):
- primary `oklch(49.12% 0.309 275.75)`; base-100 `oklch(100% 0 0)`, base-200
  `oklch(96.115% 0 0)`, base-300 `oklch(92.416% 0.001 197.137)`, base-content
  `oklch(27.807% 0.029 256.847)`; success/warning/error/info per the file.
- radius: field 0.25rem, box/selector 0.5rem. Border 1px. No shadows except the
  modal/palette/tooltip. Spacing on Tailwind's 4px scale.
- type: system sans for chrome, system mono for all data; sizes `text-xs`(12) /
  `sm`(14) / `lg`(18) / `2xl`(24) / `5xl`(48, login).
- CodeMirror token→variable map: see the `:root`/`[data-theme="dark"]` block at
  the top of `prototype/workbench.css`.

## Assets
- **No image/font assets.** System font stacks only.
- **Icons = a substitution to approve.** Data Shack ships *no icon library*; the
  IDE shell genuinely needs them. The prototype embeds **Lucide** line-icon
  paths inline. In the real repo, add **`lucide-preact`** and map the names used
  (files, search, table, database, git-branch, download, bar-chart, key,
  hard-drive, bookmark, terminal, play, x, chevron-right, plus, rotate-cw,
  settings, save, panel-bottom, history, sun, moon, log-out). **Flag this new
  dependency for the maintainer's sign-off** — it changes the product's
  "no icons" stance. Keep stroke ~1.6 to match the hairline aesthetic.

## Files in this bundle
- `prototype/index.html` — open in a browser to see the target (self-contained).
- `prototype/App.jsx` — shell + all state/reducer logic (the spec of behavior).
- `prototype/cm-setup.js` — CodeMirror 6 factory blueprint.
- `prototype/lib.jsx` — primitives, `SqlEditor` wrapper, `useLocalStorage`, icon set.
- `prototype/Explorer.jsx`, `views.jsx`, `Console.jsx`, `CommandPalette.jsx` — per-area UI.
- `prototype/workbench.css` — IDE chrome styles + CodeMirror token variables.
- `prototype/colors_and_type.css`, `ds-components.css` — the daisyUI token/component reference.
