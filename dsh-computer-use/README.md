# dsh-computer-use

Computer use for DeepSeek Harness: the agent can see a window, click, drag,
type, switch browser tabs, read the clipboard, OCR an image, record frames and
drive Chromium through the DevTools Protocol.

## What it registers

| tool | purpose |
|---|---|
| `computer_windows` | list top-level windows (pid, title, hwnd, size) |
| `computer_shot` | screenshot a window/screen; `method: "print"` captures a covered window; `x/y/width/height` crops a region |
| `computer_click` | click (window-relative when `window` is set), double/right/client |
| `computer_drag` | stepped press-move-release |
| `computer_type` | type text; `unicode: true` for non-ASCII |
| `computer_key` | SendKeys combo, e.g. `^+p`, `{ENTER}` |
| `computer_scroll` | wheel at a point |
| `computer_focus` | bring a window forward (best effort) |
| `computer_tabs` / `computer_tab` | list/select Chrome or Edge tabs via UI Automation |
| `computer_wait` | wait for a window or element, bounded |
| `computer_clipboard` | read or set the clipboard |
| `computer_window` | normal/max/min/topmost/move/resize |
| `computer_launch` | start a process and wait for its window |
| `computer_record` | frame sequence of a window (occlusion-proof) |
| `computer_ocr` | Windows OCR on a PNG |
| `computer_uitree` | UI Automation tree of a window |
| `computer_cdp` | CDP: list targets, eval JS, dump DOM, tab screenshot, frame timing |

## Install on another machine

1. Copy this folder anywhere (it is self-contained: PowerShell engine and the
   CDP helper live in `tools/`).
2. Add it to the target profile as a linked dependency:

   ```jsonc
   // <profile>/package.json
   "dependencies": { "dsh-computer-use": "link:C:/path/to/dsh-computer-use" },
   "dsh": { "profile": { "bundles": [ ... , "dsh-computer-use" ] } }
   ```

3. Make `node_modules/dsh-computer-use` resolve: `pnpm install` in the profile,
   or create a junction to this folder.
4. Optionally copy `SKILL.md` to `<DSH data>/.dsh/skills/computer-use/SKILL.md`
   so agents also get the recipe skill, and append the "Computer use" section to
   `<DSH data>/AGENTS.md`.
5. Restart DeepSeek Harness: tools are registered at boot.

Requirements: Windows (PowerShell 5.1+), Node 20+. For CDP the target app must
be started with `--remote-debugging-port=<port>`.

## Notes

- `method: "print"` uses `PrintWindow` with `PW_RENDERFULLCONTENT`, so covered
  Chromium/Electron windows still render. Region shots are a crop of that render.
- Chromium throttles timers and rAF for occluded windows: window screenshots
  stay correct, but in-page benchmark numbers need CDP or a visible window.
- UI Automation trees of Electron apps are empty unless the app enables
  accessibility (`--force-renderer-accessibility`).
- Mouse and keyboard act on the real desktop. Ask before destructive UI actions.
## Background control

Chromium/Electron apps become fully scriptable behind other windows when they
start with `--remote-debugging-port`: `computer_cdp` exposes `navigate`, `eval`,
`click`, `type`, `key`, `scroll`, `shot` and `trace` (`Input.*` domain), which
never activate the window or move the cursor. Native apps can be driven through
UI Automation patterns (`computer_ui_action`), also without focus.

Verified end to end with a real Chrome instance: clicks and typing landed in the
page while another app owned the foreground, and the pointer did not move.
## Silent launches

`computer_launch { park: true }` keeps the app out of the user's way: Chromium is
started with `--window-position=-6000,-6000` (verified rect `-6000,-6000`, debug
port still reachable), and non-Chromium apps are moved off-screen right after
their first window appears. Combine it with `computer_cdp` to work in a browser
that nobody can see or disturb.

Checks shipped with the package:

- `node tools/verify.mjs --live` — catalogue, argument mapping, engines, window
  and occlusion-proof screenshot (74 checks).
- `node tools/text-safety.mjs` — free text (quotes, `$()`, backticks, Cyrillic)
  round-trips through the engine untouched.
- `node tools/scenario.mjs` — full tool-layer scenario against a real Chrome:
  silent launch, navigate, background click/type, screenshot, trace, park.
## Boot contract

The plugin follows the same cordis contract as the working in-tree bundles:

```js
export const inject = [];                 // no hard service requirements
export function apply(ctx) {
  ctx.inject(['tools'], (toolCtx) => {    // runs once the tools service exists
    toolCtx.effect(() => { /* register 19 tools */ }, 'dsh-computer-use: tools');
  });
}
```

`node tools/contract.mjs` proves it without the host: a fake context asserts the
plugin asks for `tools` through `inject`, registers nothing before the service
exists, and registers all 19 tools once it does (host module stubbed with
`module.registerHooks`). A successful registration also appends
`registered 19 tools` to `%TEMP%\dsh-computer-use.log`, which is the post-restart
receipt.
## Verification suites

| command | what it proves |
|---|---|
| `node tools/contract.mjs` | boot contract: `inject(['tools'])` then 19 registrations (host module stubbed) |
| `node tools/verify.mjs --live` | catalogue, arg mapping, engines, windows and occlusion-proof screenshot |
| `node tools/text-safety.mjs` | free text with quotes, `$()`, backticks and Cyrillic survives the engine |
| `node tools/scenario.mjs` | silent launch → navigate → background click/type → screenshot → trace → park |
| `node tools/live-tools.mjs` | background drag, frame recording, OCR, wait, clipboard, park/unpark, Chrome tabs |
## Validate against the installed host package

`node tools/real-schema.mjs` loads the REAL `@deepseek-ai/dsh-tools` extracted
from the installed `app.asar` and passes every tool definition through its
`defineTool`. That is how the `required` field in the output schema was caught
before a restart: the host value-schema DSL forbids `required` and demands an
explicit `additionalProperties` flag, so a definition that looked fine would have
failed to register at boot.

Extract the package first (the script prints the command if it is missing):

```
node tools/asar.mjs extract "<app>/resources/app.asar" dsh/node_modules/@deepseek-ai/dsh-tools <dir>
DSH_REAL_TOOLS=<dir>/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js node tools/real-schema.mjs
```

Peers are resolved iteratively: extract whatever the import complains about
(`dsh-llm`, `dsh-typert-protocol`, `schemastery`, `cordis`, ...).
## Video of a window (`computer_video`)

`computer_video { window | pid, frames, interval, path }` records PrintWindow
frames and encodes them with ffmpeg into an MP4. ffmpeg's own `gdigrab` records a
black frame for GPU-composited windows, so the pipeline deliberately goes through
PrintWindow: a covered Chromium/Electron window still records correctly.

Measured: 30 frames at 120 ms → 8 fps, ~340 KB MP4, verified by extracting a
frame from the video and reading it.

## Trace analysis

`computer_cdp { action: "trace", path, duration }` now returns:

- `phases`: milliseconds per phase (`script`, `style/layout`, `paint`, `frames`, `composite`);
- `frameP50/p95/max`: pacing between consecutive `FireAnimationFrame` events;
- `longestTasks`: events ≥ 50 ms with their offsets;
- the raw timeline in the JSON file.

## Profiling a parked window

Chromium throttles occluded windows, which makes frames look artificially slow.
Launch with the anti-throttling switches to profile honestly:

```
computer_launch { park: true, args: "--remote-debugging-port=9499 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding about:blank" }
```

Verified: a parked animated page then traces at p50 13 ms / p95 14 ms (75 fps)
instead of zero frames.
## Profiling the DSH GUI itself

The desktop window loads the app over the private `dsh-app://` scheme, so it cannot
be opened in an external Chromium and `http://127.0.0.1:PORT/` answers 401 without
the per-process token. The web surface can:

```
dsh --profile web --no-open      # prints: dsh web: http://127.0.0.1:3080/?token=...
```

Open that URL in a parked Chrome with `--remote-debugging-port` and the
anti-throttling switches, then run `node tools/gui-profile.mjs <port> "<session title>" 3`.
It opens the session through CDP input, steps the viewport width (the same
whole-app relayout a divider drag causes) and traces the work.

First result on this machine (3656 DOM nodes, 3 s of width steps):

```
frames 269  p50 24 ms  p95 48 ms  max 144 ms  frames>50ms: 10
phases: script 16401 ms, style/layout 2702 ms, paint 1536 ms, composite 78 ms
```

Chrome keeps the GUI at 24–48 ms frames while the same app inside Electron showed
200–400 ms frames for the same relayout, so the remaining cost lives in the
Electron paint path, not in the page.
## Divider drag over CDP

`node tools/divider-drag-profile.mjs <port> "<session>" <artifactPath> <seconds>`
opens the session through CDP input, writes `.dsh/artifact-panes/open-request.json`
so the panel opens, then drags `[data-side="rightbar"]` with 16 intermediate moves
while tracing.

Limitation found on this build: the **web** surface has no right rail, so the
handle never appears even with `dsh-artifact-panes` added to the `web` profile
(its host routes answer, its client has no sidebar to mount). The desktop window
does have the handle, but loads the app over `dsh-app://` and cannot be attached
without starting DSH with `--remote-debugging-port`.

Report of what could be measured: `docs/plan/030-gui-profile.md`.
### Divider drag result

`divider-drag-trace.mjs` finds the handle, drags it 160 px in 16 moves and traces:

- empty panel (1351 DOM): p50 32 ms, p95 35 ms, no frame over 50 ms;
- session loaded (3404 DOM, 93 turns): p50 30 ms, p95 53 ms, one frame over 50 ms,
  with ~17 ms style/layout and ~11 ms paint per move.

Same drag inside Electron measured 200–400 ms per frame, so the gap is the
Electron paint path, not the page.
## Screenshots and clips appear in the chat

`computer_shot` and `computer_video` now attach their media the same way the core
`read_image` tool does: the PNG (or the clip's poster frame) is committed to the
attachment store and returned as an image block, so the picture shows up in the
conversation without a second tool call.

- `computer_shot { window }` -> the screenshot itself is the result.
- `computer_video { window, frames }` -> the MP4 path plus its poster frame.
- If the deployment has no attachment store, both fall back to returning the file
  path only, which `read_image` can display instead.

`node tools/inline-media.mjs` proves the wiring without the host: a screenshot
carries an attachment reference, `render()` emits the image block, and a context
without attachments stays text-only.