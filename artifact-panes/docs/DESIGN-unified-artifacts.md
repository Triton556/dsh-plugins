# Design: Artifacts tabs, one pane behaviour, workspace-aware picker

Status: agreed, ready for slice 1.
Goal: every artifact is shown by **one** component with the same header and picker,
whether the agent opened it, the file tree opened it, or the user picked it from
the list. Several such tabs may be open at once, but never two showing the same
file.

## Model

- One component `ArtifactsPane` with `currentPath` state and the dropdown header.
- **Tab identity is not the file path.** Each Artifacts tab owns a mutable
  `currentPath`; the tab strip title follows it, so the title always matches the
  canvas.
- **Opening a file** (agent via `dsh_artifact_open`, file tree, list):
  - if some open Artifacts tab already shows that file → focus that tab;
  - otherwise → open a new Artifacts tab with that file (the existing active tab
    is left as it is).
- **Picking inside the dropdown** switches `currentPath` of the current tab, no
  new tab. A modifier entry "открыть в новой вкладке" does open a new one.
- Open tabs and their `currentPath` are restored after a GUI/DSH reload
  (`localStorage`, keyed per session).

## Header

```
[HTML] name.html  ▾        [Reload]
```

The dropdown shows, in order:

1. **List** — `artifacts/**` of the **current** workspace (depth 3, 150 entries,
   newest first). This is the default state; no extra controls are needed for the
   everyday case.
2. **Filter** — substring over title and path.
3. **Divider + secondary controls**, small and out of the way:
   - `показать HTML вне artifacts/` — checkbox, off by default, remembered;
     when on, adds recent `*.html` of the same workspace **30 days / up to 50
     files**, excluding `node_modules`, `.git`, `.dsh`, `dist`, `build`;
   - `из другого workspace…` — compact list of workspaces known from live
     sessions (label = folder name, tooltip = path). A workspace without a live
     session is greyed as "нет открытой сессии". Choosing one switches the list
     for this tab only; the header shows the workspace name so it is never
     ambiguous.
   - `открыть в новой вкладке` — for the selected entry.
4. Empty state: "нет артефактов" + the toggle and workspace links, so a fresh
   workspace is not a dead end.

Limits and states: when the list hits 150 entries the footer says
"показано 150 из N"; scan errors are shown in the list, not swallowed.

## Host changes

Two additive routes, no new read surface:

1. `GET /artifact-panes/library?sessionId=<id>` — resolve the root from the given
   session; without the parameter behaviour is unchanged (newest live session).
2. `GET /artifact-panes/workspaces` — `{ workspaces: [{ sessionId, cwd, label,
   hasArtifacts }] }` from live sessions, deduplicated by real path.

File bytes keep flowing through `ctx.remote.workspaceFiles.readBytes(sessionId,
path)`. Security stays as in `tools/host.js`: only `*.html|*.htm|*.xhtml`, real
path must stay inside `<cwd>/artifacts`, size cap 5 MB. The recent-HTML toggle
uses the same containment rule for `*.html` inside the workspace root.

## Behaviour details

| Case | Behaviour |
| --- | --- |
| Same file opened twice | focus the tab already showing it |
| Two different files | two tabs, independent `currentPath` |
| Switch inside a tab | title follows the artifact |
| Survey/answer channel | answers go to the **current session**, even when browsing another workspace; the header shows which workspace is listed |
| Annotations | one visible artifact iframe per tab, the dock keeps working; switching a tab resets its own annotations state |
| Live reload | per tab, per file, as today (rewrites apply immediately) |
| Restore after reload | tabs and their current files come back; a file that no longer exists shows an error state |

## Slices

**Slice 1 — tab model + unified pane.**
`ArtifactsPane` replaces `ArtifactBody`; the open bridge and `openResource` go
through one opener that dedupes by the file shown and otherwise opens a tab;
titles follow content. No new host routes.
Acceptance: `dsh_artifact_open` shows the pane with the dropdown; opening the
same file twice focuses one tab; two files give two tabs; the page tab still
opens the last artifact.

**Slice 2 — picker v2.**
Workspace selector, filter, the outside-`artifacts/` toggle (30 days / 50 files),
"open in new tab", the 150/N footer, plus the two host routes.
Acceptance: switching the workspace lists its artifacts and opens them; the
toggle adds recent project HTML; a workspace without a live session is disabled;
choices survive a reload.

**Slice 3 — restore + polish + tests.**
Restore open tabs, keyboard navigation, empty/error states, docs, and a unit test
for the library route with two fake workspaces.

## Risks

- The sidebar addresses tabs by resource address today; the new opener must not
  break `openResource` for other tab kinds (browser, files, terminal).
- Restoring tabs must tolerate deleted files and removed workspaces.
- Cross-workspace reads widen what the pane can display; the header always names
  the workspace, and the tools still write only into the current workspace.

## Decisions log (2026-11-23)

- multiple tabs, dedupe by file shown, focus instead of duplicating;
- title follows the artifact;
- restore tabs after reload;
- recent HTML outside `artifacts/`: 30 days, up to 50 files;
- "open in new tab" included in the first picker version;
- workspaces from live sessions only; no session → disabled;
- default list is always the current workspace.
