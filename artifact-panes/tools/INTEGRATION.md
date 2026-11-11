# Staged artifact tools v1: integration handoff

This directory is inert staging code. Nothing here has been connected to DSH. Do not interpret passing local tests as live UI, focus-continuity or capture verification.

## File map and build

| File | Responsibility |
| --- | --- |
| `contracts.js` | Eleven tool definitions, strict runtime inputs, finite selector grammar, limits, result envelope. |
| `host.js` | Actual `ctx.tools.register(defineTool(...))` loop, caller-session authority, canonical artifact paths, private bootstrap, native image admission. |
| `bridge.js` | Authenticated JSON POST handler and bounded memory-only command queue; ownership, heartbeat, start/done receipts, deadlines, cancellation, unknown effects. |
| `client.js` | Client poller, native sidebar adapter, opaque-frame MessageChannels, document leases, native browser provider. |
| `coordinator.js` | One poller for the mounted session; retained-frame reconnect and static dispatcher insertion. |
| `iframe.js` | Fixed DOM query/act/navigate/wait dispatcher; no model code or host token. |
| `capture.js` | Fail-closed artifact-region capture provider interface. No OS capture implementation. |
| `client-bundle.js`, `iframe-dispatcher.js` | Generated plain browser scripts, with no runtime ESM loading or eval. |
| `integration-fragments.txt` | Generated client bundle plus a literal `ARTIFACT_TOOLS_DISPATCHER_SOURCE` declaration for insertion into the existing module-loader factory. |
| `tool-schemas.json`, `manifest.json` | Machine-readable contracts/limits and SHA-256 file manifest. |

From the workspace root:

```powershell
node tools/codex-worker/probe-tools-v1.mjs
node tools/codex-worker/build-tools-v1.mjs
node tools/codex-worker/test-tools-v1.mjs
```

Run commands individually. They use Node built-ins and read the installed ASAR without modifying it. No server, browser or screen control is used. The fixture is under `tools/codex-worker/evidence/tools-v1/fixture/`.

## 1. Host integration in index.js

These are future edits for the integrator, not edits made by this worker.

1. Add imports after the existing host imports:

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerArtifactTools } from './tools/host.js';
```

2. Change the injection declaration from `['webServer']` to `['webServer', 'tools', 'attachments']`. The attachment service is needed for native image content blocks. If that service is not available in this deployment, omit its injection and pass `attachments: null`; screenshot then explicitly returns `CAPTURE_UNAVAILABLE`.
3. Inside `apply(ctx)`, after resolving/checking `webServer`, register an effect:

```js
ctx.effect(() => {
  const installed = registerArtifactTools(ctx, {
    defineTool,
    // Trusted integration configuration; never tool parameters.
    // These values are for the specified HTTP DSH frontend only.
    origin: 'http://127.0.0.1:54613',
    host: '127.0.0.1:54613',
    attachments: ctx.get('attachments') || null,
    allowedBrowserOrigins: [],
  });
  return () => installed.dispose();
}, 'artifact-panes: tools-v1');
```

`registerArtifactTools` expects `ctx.webServer` and `ctx.tools` injected faces. The existing local `webServer` resolution must refer to the same face. If this build exposes only `ctx.get('webServer')`, pass a narrow facade `{ tools: ctx.tools, webServer }` instead; no other context services are used by the staged registration helper.

**Desktop scheme gate:** the `dsh-app://` desktop transport/Origin forwarding was not probed through a running window. Before enabling this block there, inspect its actual request Origin/Host and relative-route mapping using application instrumentation, without screen takeover. Configure the exact trusted values. Do not allow `*`, `null`, missing Origin, suffix matching or a token-bearing GET bootstrap route to make a failing request work. The client intentionally uses a same-origin relative POST.

Only one new route is required:

```text
POST /artifact-panes/tools-v1/channel
Authorization: Bearer <private per-session capability>
Content-Type: application/json
```

The body permits `op`, `sessionId`, `clientId`, `instance`, `id`, `phase`, `value`. Operations are `poll`, `heartbeat`, `receipt`; receipts are `start` and `done`. Session fields here come from the authenticated client bootstrap, never from the model tool input. There is no public credential or submit-command endpoint.

No static asset route is required when using the generated fragments below. If you prefer a fixed static route later, serve only the two known JS assets, not a generic path or bootstrap file. Do not fetch the dispatcher from within the artifact: its CSP denies connections.

## 2. Client packaging and runtime lifecycle

`client.js` uses `window.__ModuleLoader__.load({ factory(require) { ... } })`; it is not an ESM file. Do not insert an ESM import there.

1. Insert the complete contents of `tools/integration-fragments.txt` once inside the existing factory, after React/ReactDOM setup and before component declarations. This defines `window.DSHArtifactToolsV1` and the fixed dispatcher string. No code in that fragment starts a poller until the coordinator is explicitly created.
2. Declare a factory-local `let artifactToolsCoordinator = null;`.
3. Inside client `apply(ctx)`, after the sidebar/remote services are available, add:

```js
ctx.effect(() => {
  artifactToolsCoordinator = window.DSHArtifactToolsV1.createRuntimeCoordinator({
    win: window,
    ctx,
    captureProvider: null,          // safe default
    allowedBrowserOrigins: [],      // must match the host allowlist
    providers: {},                  // files/terminal require scoped integration
    onStatus: status => {
      // Optional developer diagnostics: only state/code/commandId/effect.
      // Do not log capabilities, typed text, query results or screenshots.
    },
  });
  return () => {
    artifactToolsCoordinator.stop();
    artifactToolsCoordinator = null;
  };
}, 'artifact-panes: tools-v1 client');
```

The coordinator subscribes to `ctx.sidebarRight.mounted`, not `currentSessionId()` or `lastSessionId`. On session switch it stops the old poller/heartbeat, closes ports and starts a caller-bound runtime for the mounted session only. Retained iframe documents reconnect through a fresh document lease. It does not switch chats.

The staged `nativeTabMetadata` uses the observed `sidebar.tabsIn(sessionId)` implementation. It is not promised by the public interface; feature-check it, pin the source manifest and retest on DSH upgrades. The metadata returned to the model has only tab ID, safe kind and active flag for non-artifact tabs.

## 3. Package dispatcher into artifact HTML

At the existing `renderHtml(bytes)` anchor near production line 699, replace only its return expression in the future integration:

```js
return window.DSHArtifactToolsV1.withPackagedDispatcher(
  withPicker(withCsp(bytes)),
  ARTIFACT_TOOLS_DISPATCHER_SOURCE,
);
```

This preserves the CSP and annotation picker. The new fixed script is inserted before `</body>`, after the picker. No `allow-same-origin`, eval, remote script permission or CSP relaxation is needed. Keep the existing `form-action 'none'`, `connect-src 'none'` and frame sandbox. The packaged dispatcher escapes closing script tags. It listens only for the parent window's port handoff; host credentials never cross into the iframe.

## 4. Register iframe identities and reload callbacks

Both HTML paths need load/cleanup hooks: `ArtifactBody` (production iframe around line 1024) and HTML selections in `ArtifactBrowser` (around line 1267). The browser canvas also needs its own `useTabInfo()` so its *native tab ID* is used; never use the filename as tab ID. Restrict registration to validated HTML paths beneath `artifacts/` belonging to the mounted session.

In each component, create an unregister ref, a dedicated tool reload callback and a memoized onLoad callback. `ArtifactBody` example, using its existing `tab`, `parts`, `read`, `applyData`, `url`:

```js
const unregisterToolFrame = React.useRef(null);
const toolReload = React.useCallback(async ({signal, deadline}) => {
  const response = await read(
    { sessionId: parts.sessionId, path: parts.path },
    signal,
  );
  if (!response || response.ok === false || !response.value?.data) {
    throw new Error('Artifact reload read failed');
  }
  if (signal.aborted || Date.now() >= deadline) {
    throw new Error('Artifact tool reload expired before applying bytes');
  }
  // Explicit tool reload intentionally remounts even identical bytes.
  // This is distinct from the existing background/pending-update behavior.
  applyData(new Uint8Array(response.value.data), response.value.version);
}, [read, parts && parts.sessionId, parts && parts.path, applyData]);

const onToolFrameLoad = React.useCallback(event => {
  unregisterToolFrame.current?.();
  unregisterToolFrame.current = null;
  if (!parts || !artifactToolsCoordinator) return;
  unregisterToolFrame.current = artifactToolsCoordinator.registerFrame({
    sessionId: parts.sessionId,
    tabId: tab.id,
    path: parts.path,
    iframe: event.currentTarget,
    reload: toolReload,
  });
}, [parts && parts.sessionId, parts && parts.path, tab.id, toolReload]);

React.useEffect(() => () => {
  unregisterToolFrame.current?.();
  unregisterToolFrame.current = null;
}, [url]);
```

Add `onLoad: onToolFrameLoad` to that iframe element and add the callback to that memo's dependencies. Do not add frame geometry, observer state, tool receipts or heartbeat state to iframe memo dependencies. The new byte array on explicit tool reload is intentional; ordinary sidebar resize must retain the existing element/Blob URL.

For `ArtifactBrowser`, use the same structure with `sessionId`, `tab.id`, `current.path`, `state.url`; its tool reload reads that exact path and calls `applyData(new Uint8Array(response.value.data), current.path)`. Do not change its menu, pending updates, draft restoration or annotation channel.

The current `ArtifactBody.readOnce` source at lines 935–937 calls `read(...)` without returning its promise. This was observed read-only. Do not base the new callback on that helper as it stands; the example above calls `read` directly. Existing behavior of that helper is outside this staged change and requires integrator review.

The iframe `onLoad` hook must register after the dispatcher has executed. Components already mounted when enabling this integration require one ordinary UI reload; do not try to access their opaque DOM or inject arbitrary code into a running frame.

## 5. Two panel providers and the browser boundary

Artifact file tabs use the native observed `openResource`, `close`, `active`, `focus` methods, while all DOM work uses the packaged dispatcher.

The browser provider is implemented with the observed `openTab('browser', {params:{url}, revealIfOpened:false})` pattern. It is disabled by an empty origin allowlist. It refuses credentials, query strings, fragments, non-HTTP(S) schemes and unknown origins. Browser tabs are **not** DOM-query/act/screenshot targets in v1. Enabling a test-app origin allows that page to load via its native provider; it is an explicit integration policy, not a model option.

`files` and `terminal` are accepted command kinds with executable provider hooks and explicit `UNSUPPORTED_PANEL` if missing. Do not wire them blindly to `openTab`:

* The installed Files body takes its root from session cwd (source line 1734), not an artifacts-only tool root, and its page ignores a proposed `path` parameter.
* The terminal navigation accepts `terminalId`/`shellPath` (source 561–569); an arbitrary artifact cwd/path setter was not found. Opening a new native terminal can launch a shell at workspace scope.

To enable them within the agreed scope, supply trusted `providers.files` / `providers.terminal` functions:

```js
async function scopedProvider({ sessionId, path, focus, deadline, signal }) {
  // path has passed host canonical file/directory and relative artifacts checks.
  // Open ONLY the approved artifact-file view or an existing isolated terminal
  // rooted at that artifact directory. No shell command input exists.
  // Do not expose workspace trees, terminal output, account/settings or chats.
  // Respect signal/deadline and do not call OS focus/keyboard/mouse APIs.
  return { tabId: 'actual-native-tab-id', effect: 'applied' };
}
```

The comment describes an integration contract, not a supplied native implementation. If a provider issued an operation but cannot confirm its result, throw `ToolError(..., ..., 'unknown')`; a policy refusal before issue has `none`. A plain unexpected provider exception is treated as `unknown` by the adapter. If the native APIs cannot supply this isolation, leave those kinds unavailable rather than opening a broader workspace. This is a documented v1 limitation for the orchestrator to resolve.

## 6. Capture provider gate

Default `captureProvider: null` returns `CAPTURE_UNAVAILABLE`. The existing `/artifact-panes/screenshot` / `shot.ps1` route is **not** used: it obtains a full-window PrintWindow image before cropping. No full-window or desktop fallback exists here.

A future provider must be independently verified before setting:

```js
{
  scope: 'artifact-region',
  verifiedArtifactOnly: true,
  async capture({sessionId, tabId, documentId, artifactElement, deadline}) {
    // Must receive only pixels of this artifact's own DSH region/surface.
    // Must not capture a full window and crop, other tabs/windows, or OS screen.
    return {scope:'artifact-region', documentId, mimeType:'image/png',
            base64:'<canonical PNG bytes>', width:640, height:480};
  }
}
```

The flags do not prove isolation. Audit the provider implementation and test occlusion, clipping, DPI, session/document changes and panel motion before enabling it. The staged wrapper rejects identity/size/encoding mismatches and a moving target. It has a 4096×4096 dimension cap and 1,400,000 base64-character cap; no file/URL image references can be supplied by a model.

On receipt, the host calls the installed `attachments.saveImages([{data: Uint8Array, mediaType:'image/png', name:'Артефакт.png'}])`. Native render output is `{type:'image', attachment:<durable reference>}`, as the installed DSH LLM content uses `block.attachment`. Raw MCP `{mimeType,data}` image content is not used. Actual attachment writes/native image presentation were not run.

## 7. Package exports and files (future edit)

Add `tools/` to `package.json.files` so relative host imports are packaged. Existing exports can remain unchanged with the embed strategy. Optional external consumers may use a new `"./tools": "./tools/host.js"` export; this is not required by `index.js`'s relative import. Do not replace `"./client"` with the generated bundle: the existing production module-loader registration remains the plugin client entry point.

## 8. Bootstrap and operational sequence

The first tool call creates a private capability file at:

```text
<caller cwd>/.dsh/artifact-panes/tools-v1/<sha256(session ID)[0:24]>.json
```

This is plugin transport state, **not** the command journal. It contains a per-host-lifetime random 256-bit capability plus caller/client identifiers. It has no chat or typed/query data. The host writes mode 0600 with atomic temp-file rename; Windows ACL privacy still requires deployment verification. Parent paths are canonicalized and symlink redirection outside the caller workspace is rejected. It is not served by HTTP and must be excluded from generic workspace/artifact exposure. The client reads only its mounted session's file through the already authenticated DSH `workspaceFiles.readBytes(sessionId, relativePath, {}, signal)` remote, decoding `res.value.data` as in the existing client.

Suggested UX sequence: `artifact_list` → allow first heartbeat (poll ≤300 ms) → `artifact_open` → `artifact_query` / `artifact_act` → `artifact_wait` / query → optional screenshot. If an open is the very first call, it can return `CLIENT_STALE` with `effect:none` while bootstrap starts; retry only after heartbeat. Unknown mutations must never be automatically repeated.

Memory queue: 32 pending per session; one delivered/started command per session; 15 s command deadline; 18 s tool timeout; poll 300 ms, heartbeat 1.5 s, stale after 6 s; 256 metadata-only journal entries. The client sends a start receipt and waits for host acknowledgement before execution. A missing done receipt after start is `UNKNOWN_EFFECT`. There is no replay on process restart or client replacement. This is at-most-once delivery within the current broker lifetime, not transactional exactly-once execution.

## 9. Integration verification and rollback

Before production enablement, the orchestrator must verify actual tool visibility, HTTP/desktop route headers, caller binding across two sessions, mounted-session refusal, tab close/reload/stale targets, CSP/annotation compatibility, native focus behavior while another app owns the screen, receipt-loss recovery and bounded waits. No CUA or desktop capture is needed for tool tests once the bridge works. Do not test in user chats/drafts; use a dedicated artifact fixture and leave existing annotations untouched.

Remove the legacy open-request polling effect (production lines 2832–2889) only when the new channel is proven. Do not run both command issuers in production or keep the latest-chat fallback as authority. Do not delete the old user-owned request file.

Rollback: dispose host registration and coordinator; remove the integration effect, frame load/cleanup callbacks, static fragments and `withPackagedDispatcher` wrapper; restore prior injection/package declarations. Leave transport files inert rather than deleting user data; broker disposal invalidates their capabilities. Restore the old effect only if that is the chosen rollback. Existing artifact bodies, picker, chip fill, annotation timers and screenshot/draft routes remain otherwise intact. No commit or push is included.
