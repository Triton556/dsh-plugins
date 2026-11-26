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

**Slice 4 — closed workspaces (design below).**
Read and show artifacts of a workspace with no live session: two host routes
(`/library?root=`, `/file`), a new tab address scope, the picker offering closed
workspaces, and a "closed" mark in the header.

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

# Slice 4: artifacts of a closed workspace

Status: implemented and verified live (2026-11-23). Supersedes the slice-2 line
"no live session → disabled".

Goal: a workspace listed in the picker **because a closed session used it** can be
browsed and its artifacts shown, without reopening that session first.

## Verified state (2026-11-23, read-only checks)

Local identifiers in these examples are synthetic; the recorded test outcomes are unchanged.

- `GET /artifact-panes/workspaces` is live and returns a closed entry:
  `{"sessionId":null,"cwd":"C:\\Users\\Example\\Documents\\DSH\\sample-workspace",
  "hasArtifacts":true,"live":false}` next to the live `sample-active-workspace` session
  (checked with `Invoke-WebRequest http://127.0.0.1:<port>/artifact-panes/workspaces`;
  the GUI answers its own web routes on localhost).
- Tabs are claimed by address only: `SidebarRight.claim` consults the tab-type
  registry (`patterns` + `canOpen`), not the resource model, so a new address scope
  in `dsh-resource://file/...` opens as long as this plugin claims it
  (`dsh-client-ui-sidebar-right/src/client/tab-registry.ts`, `service.ts`).
- The built-in `file` resource provider parses only `session/` and `absolute/`
  scopes and answers any other scope with one typed failure frame
  (`dsh-api-workspace-files/src/client/provider.ts`,
  `dsh-util-workspace-path/src/file-address.ts`). No built-in code resolves a new
  scope; none is broken by one.
- The client has two surfaces with the same workspace selector and list:
  `ArtifactBody` (a file tab, `ArtifactMenu`) and `ArtifactBrowser` (the Artifacts
  page). The tab menu already opens a tab via `openResource`; the page shows the
  chosen artifact in place.
- `sample-workspace/artifacts` holds both small HTML (`sample-report.html` 1.6 KB) and
  oversized ones (`oversized-sample.html` 11 MB, `oversized-secondary-sample.html` 18 MB): live cases for the
  5 MB cap and for refusal.

## Chosen option

**New tab address scope `workspace`, plus two read-only host routes.**

```
dsh-resource://file/workspace/<base64url(root cwd)>/artifacts/<rel path>
```

- The root travels inside the tab identity, so a closed-workspace tab survives a
  reload and needs no in-memory registry or synthetic session id.
- The tab title stays `basenameOf(address)`, exactly like a session tab.
- Rejected: naming the file by `absolute/<path>` (carries no root, so the read
  route would have to re-derive it and the grammar would claim "no session"
  semantics that do not apply); a fake session id (would hit the real
  `workspaceFiles` remote and fail in a way the user cannot read).
- Rejected: reading bytes through `ctx.remote.workspaceFiles` with a synthetic
  session — the Host authorizes by session, so there is nothing to authorize.

The known-workspace set is the single source of truth for both routes: the cwds of
live sessions plus the cwds in `$DSH_HOME/storages/session_projcache/sessions/*.json`
(`record.identity.cwd`). A requested `root` must normalize (case-insensitive,
`path.resolve`, no trailing slash) into that set; anything else is `403`.

## Host protocol

### `GET /artifact-panes/file?root=<cwd>&path=<workspace-relative path>`

| Case | Status | Body |
| --- | --- | --- |
| ok | 200 | `{ok:true, dataBase64, mime:'text/html; charset=utf-8', size}` |
| `root`/`path` missing, empty, not a string, or `root` not absolute | 400 | `{ok:false, error}` |
| path is absolute, or carries a `..` segment | 400 | `{ok:false, error}` |
| `root` not in the known-workspace set | 403 | `{ok:false, error:'root not allowed'}` |
| real path of the file is not inside `<real root>` | 403 | `{ok:false, error:'outside workspace'}` |
| file does not exist / is not a regular file | 404 | `{ok:false, error:'not found'}` |
| extension is not `html|htm|xhtml` | 400 | `{ok:false, error:'not html'}` |
| size > 5 MB (5 · 1024 · 1024 bytes, `stat` before read) | 413 | `{ok:false, error:'file too large'}` |

Reads use plain `node:fs/promises` on the resolved absolute path (the sandboxed
`fs` service refuses paths outside the sandbox, and a closed workspace is exactly
that case). Containment is checked on `realpath` of both `<root>` and the file, so
a symlink out of the workspace is refused. The read surface is wider than
`artifacts/` on the owner's decision: any `*.html|*.htm|*.xhtml` inside a known
workspace root, so the already-listed "HTML вне artifacts/" rows are readable too.
Nothing else is served: not `.md`, `.pdf`, `.png`, `.wav`, not a directory, not the
workspace root itself.

### `GET /artifact-panes/library?root=<cwd>[&outside=1]`

Same known-root check (`403` otherwise). The scan is the existing walk, run through
a `node:fs` adapter shaped like the `fs` service (`resolve` → target, `listDir`,
`readText`, `processPath`) so there is one list implementation, not two. Entries and
the response keep today's shape (`path`, `rel`, `title`, `size`, `mtime`, `root`).
`outside=1` keeps its session-mode rule (recent HTML outside `artifacts/`, 30 days,
≤ 50 files, depth 3, build folders skipped) and now works in root mode as well,
because `/file` serves those files too.

## Client

**Address grammar.** `parseFileAddress` learns one more scope and a builder joins
it:

```js
workspaceFileAddress(root, 'artifacts/x.html')
  // dsh-resource://file/workspace/QzpcVXNlcnNcLi4u/artifacts/x.html
```

base64url of the root's UTF-8 bytes: ASCII-only, no `/` or `%` surprises inside a
path segment. `canOpen` accepts `scope === 'workspace'` with the same
`*.html|*.htm|*.xhtml` rule; `absolute/` stays refused.

**Reading.** Both surfaces read through one helper that dispatches on the file's
origin: a session file keeps `ctx.remote.workspaceFiles.readBytes`, a workspace
file becomes `fetch('/artifact-panes/file?root=…&path=…')` → `dataBase64` decoded to
a `Uint8Array`. The result shape stays `{ok, value:{data, version}}` /
`{ok:false, error:{message}}`, so the polling, fingerprinting and live-reload code
is untouched. The request path is the `rel` the library already returns
(workspace-relative, so `artifacts/x.html` or a recent HTML outside it), not a
string rebuilt from the absolute path.

**Picker.** A closed entry becomes selectable (`value = cwd:<cwd>`, no `disabled`),
labelled `label` (tooltip = cwd). The selection decides where the list comes from:

| Selected | Library request | Opening a row |
| --- | --- | --- |
| this tab's workspace, live | `/library` (no params) | session tab (`sessionFileAddress`) |
| another live workspace | `/library?sessionId=…` | session tab |
| a closed workspace | `/library?root=…` | workspace tab (`workspaceFileAddress`) |

`outside=1` can be combined with every row of that table. In `ArtifactBrowser` the
same three cases keep its current behaviour — the chosen file is shown *in that
page* — but the read goes through the dispatch helper, and `current` carries the
optional `root` it came from. The page therefore no longer needs a live session to
display a closed workspace artifact.

**Header mark.** A workspace-scope tab shows a `закрыт` chip in its header
(tooltip = the workspace path), so the tab never looks live. The Artifacts page
shows the same chip while a closed workspace is selected, and its select option
reads `sample-workspace (закрыт)`.

**Consequences to keep in mind.** Answers from a survey inside a closed-workspace
artifact still go to the *current* workspace (the answer route resolves by the
current session), as the design already states for cross-workspace browsing. The
`file` resource stream of such a tab ends with one `unknown-workspace` frame; the
body only reads `version` from a `live` snapshot, so nothing else reacts to it.

## Tests

`test/host.test.mjs` (fake `$DSH_HOME` with one `session_projcache` record):

1. `/library?root=<closed cwd>` lists that workspace's artifacts and returns
   `root = <cwd>/artifacts`; `/library?root=<unknown>` → 403.
2. `/file?root=<closed cwd>&path=artifacts/demo.html` → 200, base64 decodes to the
   file bytes, `mime` is `text/html`; a recent HTML outside `artifacts/` → 200 as
   well.
3. Escape attempts → 403: `../outside.html`, `artifacts/../outside.html`,
   `artifacts/../../root.html`, and a symlink under `artifacts/` pointing outside
   the workspace.
4. A foreign root (not live, not in the index) → 403.
5. Non-HTML (`artifacts/notes.txt`, `artifacts/pic.png`) → 400; missing params and
   absolute `path` → 400.
6. A 5 MB + 1 byte file → 413; a file just under the cap → 200.
7. Missing file → 404; a path to a directory → 404.

`test/client.test.mjs`: `canOpen` accepts the `workspace` scope for html and still
refuses `absolute/` and non-html; the workspace address round-trips to the same
root and relative path.

## Live verification (no screenshots)

Local identifiers in these examples are synthetic; the recorded test outcomes are unchanged.

Host, straight over localhost (the GUI answers its own routes):

```
GET /artifact-panes/file?root=C:\Users\Example\Documents\DSH\sample-workspace&path=artifacts/sample-report.html   → 200
GET /artifact-panes/file?root=<same>&path=../DECISIONS.md                                                    → 403
GET /artifact-panes/file?root=C:\Windows&path=artifacts/x.html                                               → 403
GET /artifact-panes/file?root=<same>&path=artifacts/oversized-sample.html                                            → 413
GET /artifact-panes/library?root=<same>                                                                      → 200, artifacts of sample-workspace
```
Client, through the existing DOM channel (`.dsh/artifact-panes/ui-command.json` →
answer route), extended with two read-only commands: `select` (set a native
`<select>` value and dispatch `change`) and `http` (GET an `/artifact-panes/*` URL
from the page and return status + the first bytes), so no screenshot is needed:

1. open an artifact tab, open the dropdown, `select` `cwd:<sample-workspace>`;
2. `query .dap-menu .dap-item` → the closed workspace's rows, workspace-relative;
3. `click` the `sample-report.html` row → a new tab whose header contains
   `закрыт` and whose title came from the file's `<title>` (proves the bytes went
   through `/file`);
4. `click` the `oversized-sample.html` row → the tab shows the 413 error, not a blank pane.

## Out of scope for this slice

- Writing into a closed workspace, and the file tree, browser and terminal tabs.
- The Artifacts page opening closed-workspace artifacts in extra tabs (it shows
  them in place; the tab menu is what opens tabs).
- Restoring `ArtifactBrowser`'s selected workspace after a reload (unchanged).

## Risks

- A wrong root normalisation could deny a legitimate workspace (case, symlinked
  home, trailing slash) — the check compares resolved, case-folded paths and the
  error is explicit; the tests pin the accepted and refused cases.
- A closed-workspace tab depends on the root still existing; if the folder moves,
  the tab reports a read error instead of silently showing something else.
- `node:fs` in the two routes bypasses the sandbox `fs` service; the only roots it
  will touch are the ones the workspace list already exposes, and only HTML files
  inside them.

## Decisions log (slice 4, 2026-11-23)

- reading is allowed across the whole workspace root, not only `artifacts/`
  (owner's choice): the "HTML вне artifacts/" rows the list already offers must be
  openable, and the realpath containment on the root is the security boundary;
- a closed workspace in the Artifacts page shows the file **in place**, like a live
  one; the file tab's menu is what opens a new tab;
- the select's empty value always means the live session's workspace; a closed
  workspace stays a listed option (`cwd:<path>`), and the one in force is never
  filtered out of the option list, or a native select could not display it;
- host statuses: 400 malformed path / non-HTML / non-absolute root, 403 unknown
  root or realpath outside it, 404 missing file or directory, 413 over 5 MB;
- `..` and absolute paths are malformed requests (400), not permission failures:
  the client never builds them, and the containment check stays on the root.

## Verification results (2026-11-23, live)

Local identifiers in these examples are synthetic; the recorded test outcomes are unchanged.

Host, against a closed workspace (shown with a synthetic path) `C:\Users\Example\Documents\DSH\sample-workspace`
(`GET` from the GUI origin, `http://127.0.0.1:<port>`):

| Request | Result |
| --- | --- |
| `/workspaces` | 200, `sample-workspace` with `sessionId:null, live:false`, live `sample-active-workspace` beside it |
| `/library?root=sample-workspace` | 200, 22 artifacts, workspace-relative `rel`, titles read |
| `/library?root=sample-workspace&outside=1` | 200 (no HTML outside `artifacts/` in that workspace) |
| `/library?root=sample-workspace\` (trailing separator) | 200, same listing |
| `/library?root=C:\Windows` | 403 `root not allowed` |
| `/file?…&path=artifacts/sample-report.html` | 200, small file, `text/html`, base64 decodes to the page with its `<title>` |
| `/file` for `docs/plan/plan.html` of a live workspace | 200 (outside `artifacts/` is readable) |
| `/file?…&path=../DECISIONS.md`, `artifacts/../../x.html`, `C:/a.html` | 400 `path must be relative to the workspace` |
| `/file?root=not-absolute` | 400 `root must be absolute` |
| `/file?…&path=artifacts/sample-audio.wav` | 400 `not html` |
| `/file?…&path=artifacts/oversized-sample.html` (11 MB) | 413 `file too large`, reported size above `limit: 5242880` |
| `/file?…&path=artifacts/nope.html` | 404 `not found` |
| `/file?root=C:\Windows&path=…` | 403 `root not allowed` |

Client, through the DOM channel (no screenshots):

- the picker offered `sample-workspace (закрыт)`, `disabled:false`; selecting it listed the
  22 artifacts of the closed workspace with workspace-relative paths;
- clicking `sample-report.html` opened a **new tab** whose header read
  `HTML Пример отчёта закрыт ▾ artifacts/sample-report.html` —
  the mark plus the `<title>` proves the bytes came through `/file`;
- the same selection inside the **Artifacts page** rendered in place: header
  `… закрыт 22 ▾`, one iframe with the artifact;
- `oversized-sample.html` produced `Could not read the file / file too large` both in a
  tab and in the page — no blank pane;
- the channel's `http` probe returned the same 400 body as the direct request.

Two defects were found by that check and fixed before the last round:

- the page listed the selected closed workspace as an option and the code filtered
  it out, so the controlled `<select>` could not show `cwd:…` and fell back to `''`
  — the option in force is now always kept in the list;
- the page fetched `/workspaces` once at mount; right after a DSH restart it mounts
  before the session turns live, so it marked the live workspace "закрыт". It now
  refetches whenever the menu opens. Re-checked: `'' = sample-active-workspace — текущий`,
  `sample-workspace (закрыт)`, and selecting the closed one returns `cwd:C:\…\sample-workspace`.

Tab-menu regression after those edits: the picker listed the 22 closed artifacts and
clicking `sample-status.html` opened
`HTML Пример страницы состояния закрыт ▾ artifacts/sample-status.html`.

# Slice 5: an explicitly declared external artifacts root

Status: implemented, unit-tested and probed against the real archive (2026-11-26).

Goal: a workspace may keep `artifacts/` physically outside its directory (for
example on another volume) while every existing address, tool and tab keeps
working. The workspace declares the folder; the plugin validates the declaration
and holds the same boundary.

## Declaration

`<workspace>/.dsh/artifact-panes.json`:

```json
{ "artifactsRoot": "D:\\\\Example\\\\ArtifactArchive" }
```

- Read only when it is a regular file inside the workspace - not a junction, not
  a symlink - at most 4 KiB, valid JSON with exactly one field.
- `artifactsRoot` must be an absolute path; it is resolved with `realpath` on
  every call and must exist and be a directory.
- Any other shape is `ARTIFACTS_ROOT_INVALID`: an error, never a silent fallback
  to `<cwd>/artifacts`.
- A declaration only affects its own workspace.

## Logical address unchanged

`artifactPath()` already requires `artifacts/...`; that stays the logical
namespace. With a declaration the physical path is
`<declared root>/<project>/<topic>.html`; without one it remains
`<cwd>/artifacts/...` under the historical containment rule. The `rel` field the
picker returns, the tab address and the tool path keep their old values, so no
stored link or tab identity changes.

## Host

- `tools/artifacts-root.js` is the single resolver: `artifactsScope(cwd)` returns
  `{ root, base, declared }`, and `physicalArtifact` maps the logical address onto
  the physical base.
- `resolveArtifact`, `resolveArtifactLocation` and `listArtifacts`
  (`tools/host.js`) call it, so there is one rule, not four copies.
- The list walk starts at the declared base, never steps through a junction
  inside it (dirent symlink check plus a realpath containment guard), and counts
  only directories and candidate pages against its scan budget: a 40 000-entry
  binary archive must not hide the pages behind it.
- `/library` returns `root` = the physical base and `rel = artifacts/...` for
  every page. `/file` maps `path=artifacts/...` onto the declared base; any other
  workspace HTML still resolves inside the workspace root.
- `<title>` is read only for pages up to 1 MiB: a 100+ MB page is not decoded on
  every 6 s scan just to label a row.
- `/workspaces` keeps its response shape; `hasArtifacts` also accepts a valid
  declaration, so a declared workspace stays selectable while closed.

## Statuses

| Case | Status |
| --- | --- |
| undeclared `artifacts/` junction out of the workspace | 403 `outside workspace` |
| realpath of the file leaves the declared root | 403 `outside workspace` |
| `..`, absolute path, empty segment | 400 |
| not html | 400 |
| over `ARTIFACT_BYTES_LIMIT` (5 MiB) | 413 |
| invalid declaration file | 500 `artifacts root declaration is invalid` |
| missing file | 404 |

## Verification (2026-11-26)

- `node --test test/` -> 7/7, including the new `test/external-root.test.mjs`
  (declaration, junction in and out, traversal, non-HTML, 413, every broken
  declaration form, `/workspaces` shape).
- The real archive `D:\Example\ArtifactArchive`, through the new code:
  `resolveArtifact` maps `artifacts/sample-audit-20261126/index.html` to
  `D:\Example\ArtifactArchive\sample-audit-20261126\index.html`; `listArtifacts` returns all
  8 HTML pages in 197 ms; `/library` returns 24 rows with `rel=artifacts/...`;
  `/file` for the island page -> 200; for the 123 MB
  `fracture-steps-20261124/index.html` -> 413.

**The junction still matters for live-session tabs.** A session-scope tab reads
bytes through `workspaceFiles`, which resolves `artifacts/...` against the
session cwd, so `<cwd>/artifacts` must exist (it does by the owner's storage
decision). Tools, `/library` and closed-workspace tabs read through the host and
need only the declaration. The live check below showed the difference: in a
workspace without the junction the tab displayed
`no entry at "artifacts/..."` until a temporary project junction was added.

## Live verification after the DSH restart (2026-11-26, GUI 127.0.0.1:50910)

- `dsh_artifact_list` in a session whose workspace declared the archive:
  `ok:true`, all 8 HTML pages (`sample-audit-20261126/index.html`
  included). `truncated:true` comes from the walk's 500-entry budget being
  filled by 492 directories (9 at level 1, 58 at level 2, 425 at level 3) plus
  the 8 pages - the `limit` (50) is not the cause, and the archive holds exactly
  these 8 pages.
- `dsh_artifact_open artifacts/sample-audit-20261126/index.html`:
  `ok:true`, `effect:applied`, tab `tab2`, `documentId` observed, `ready:true`.
  `dsh_artifact_query` on `h1` returned
  `Почему бочка в башню вешает мир на 175 мс`, so the bytes really rendered.
- Literal acceptance in the **sample-workspace session** `session-…` (the user
  opened it and ran the three calls): `dsh_artifact_list` -> `ok:true`, the same
  8 pages; `dsh_artifact_open` -> `ok:true`, `effect:applied`, tab `tab4`,
  `documentId` `3a95ead4-…`; `dsh_artifact_tabs` -> `tab4`, `ready:true`,
  `active:true`. This is the case that used to fail with
  `PATH_OUT_OF_SCOPE: Artifacts root escapes workspace`.
- `/file` island -> 200 (28420 bytes); the 123 MB page -> 413; `..` -> 400;
  `.md` -> 400; `/library?root=sample-workspace` -> 200 with root
  `D:\Example\ArtifactArchive` and 24 rows whose `rel` starts with
  `artifacts/`; `/workspaces` kept its keys (sample-workspace was offered as
  `live:false` with `indexId` after the restart closed its session).
- Removing the declaration restored the boundary: `/file` -> 403
  `outside workspace`, `/library` -> `ok:false`; restoring it -> 200 again.
  The temporary declaration and junction used for this check were removed
  afterwards, and the external archive was not modified.

## Decisions log (2026-11-26)

- an explicit declaration instead of teaching the plugin to accept any junction:
  the workspace states the folder, the plugin holds the boundary;
- the declaration is strict and fails loudly;
- `rel` stays `artifacts/...` so tab identity and stored links do not change;
- the knowledge-base note "junction out is a deliberate boundary test" is split,
  not deleted: no declaration -> 403, declaration -> 200.

## Fix round after the Astra review (2026-11-27)

An independent review (thread `01a21730…`, report
`.agent-runs/astra-plugin-review-20261126/final.md`) confirmed the acceptance and
found four problems in this change. Fixed here:

- **Missing `artifacts/` no longer blocks ordinary workspace HTML.** `/file`
  resolves the workspace root for paths outside `artifacts/` and only asks for
  the artifacts scope for `artifacts/...`; `/library` treats an absent folder as
  zero artifact rows and still runs the `outside=1` scan. Before, a workspace
  with `root-page.html` and no `artifacts/` answered 403 and `ok:false`.
- **The library walk keeps the boundary.** It skips `symlink` entries, and every
  candidate page (main and `outside=1` walks) is realpath-checked against the
  physical artifacts folder or the workspace root before it is listed or its
  `<title>` is read. A file link pointing outside is neither listed nor read.
- **A regular file named `artifacts` is refused.** `artifactsScope` requires a
  directory, so such a workspace is neither served nor advertised by
  `/workspaces`.
- **A Windows declaration must be fully qualified.** `path.isAbsolute('/archive')`
  is true on Windows but names no drive; a drive or UNC path is required.
- Tests now allocate a unique `DSH_HOME` with `mkdtemp`, so concurrent runs
  cannot erase each other's fixtures.

Interaction with the deferred-command feature (2026-11-26): that change removed
`openWithoutClient` in favour of the host-side queue, so the review's finding
about writing `open-request.json` through an unchecked path no longer applies.

Still open from the review (separate work): the session-tab read path uses
`workspaceFiles` instead of the host resolver (finding 2, the important one), the
answer/draft routes resolving the newest session (finding 6, pre-existing),
`/library` scan cost (finding 10), and the bootstrap/native-host findings.

Live verification after the fixes: pending a DSH restart (host code is read at
process start). Tests: `node --test test/` = 8/8, manifest hashes match.

## Fix for finding 2: one resolver for live tabs (2026-11-27)

A session tab used to read bytes through `workspaceFiles` at `<session cwd>/<path>`.
With a declared root that is a different tree: without the junction the tab failed
after a successful open; with a divergent local `artifacts/` it could show a file
the host never approved; and the 5 MiB `/file` cap did not apply.

Now `ArtifactBody` and the Artifacts page read `artifacts/...` through
`/artifact-panes/file?root=<session cwd>&path=...`, the same resolver `/library`
uses. The cwd comes from a new read-only `GET /artifact-panes/session-root?sessionId=`
route: the host resolves the session from its own sessions service and applies the
known-workspace check. The client caches it per session (a session header's cwd is
immutable). Other workspace HTML (outside `artifacts/`) keeps the `workspaceFiles`
read, because the declaration does not apply there. If the session is unknown or
the route is unavailable, the client falls back to the old remote read. The tool
protocol, tab addresses and the deferred-command queue are unchanged.

Consequences: a live tab honours the declaration without a junction, applies the
5 MiB cap, and shows exactly the file the host authorized. Tests: 8/8. Live check
pending a DSH restart (client and host code load at process start).
