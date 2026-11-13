# DSH plugins

Plugins and tooling for **DeepSeek Harness (DSH)** — a desktop agent host. This
repository collects the bundles we actually run in the desktop profile, with their
engines and verification suites.

## What is inside

| package | what it does |
|---|---|
| [`dsh-computer-use`](dsh-computer-use/) | 20 first-class tools for driving the desktop: windows, occlusion-proof screenshots, click/drag/type/hotkeys/scroll, focus, Chrome tabs, waits, clipboard, window control, silent launches, frame/video recording, OCR, UI Automation and the Chrome DevTools Protocol |
| [`artifact-panes`](artifact-panes/) | Artifact panel for the chat: tabs with HTML artifacts plus a draggable divider (blue when widening, red when narrowing) that snaps on release and commits the width outside the gesture |
| `dsh-claude-style` | Skin: typography, spacing and the mascot/ring indicators that make the desktop app read like a Claude-style workspace |
| [`docs/`](docs/) | Research notes, plan and stories for the GUI performance work, crash reports collected from the machine |
| [`tools/`](tools/) | Standalone helpers: `asar.mjs` (inspect any Electron `app.asar`), PowerShell computer-use engine, health/crash collectors |

## `dsh-computer-use` in detail

Registered as a bundle in the desktop profile; every tool returns `{ ok, text }`,
and screenshots/clips also return an inline attachment so the image shows up in the
chat.

**Observation** — `computer_windows`, `computer_shot` (window-relative crops,
occlusion-proof `PrintWindow` capture), `computer_uitree`, `computer_ocr`,
`computer_clipboard`, `computer_wait`, `computer_record`, `computer_video`
(`mp4`, or an animated `gif` that the chat can display).

**Input** — `computer_click`, `computer_drag`, `computer_type` (unicode-aware),
`computer_key` (SendKeys syntax), `computer_scroll`, `computer_focus`,
`computer_ui_action` (UI Automation patterns, acts without focusing the window).

**Windows and apps** — `computer_window` (move/resize/min/max/topmost/untopmost/
park), `computer_launch` (silent off-screen start, `--remote-debugging-port`
support), `computer_tabs` / `computer_tab` (browser tabs through UI Automation).

**Browser automation** — `computer_cdp`: list targets, evaluate JS, dump DOM,
screenshot a tab, dispatch background input (click/drag/type/key/scroll), sample
frame timing, write a DevTools trace with a phase breakdown and frame pacing.

## On-screen indicator and consent rules

While the agent drives the machine, the user always knows what is happening:

- **whole-screen input** (`click/type/scroll` without a window target) is refused
  with `REFUSED` until the agent asks the user and passes `user_ready: true`;
  a banner "DeepSeek using your computer / ESC to stop" is shown while it runs;
- **ESC** cancels what is happening now, exactly like Codex/Claude computer use:
  the in-flight engine process is killed at once and the next call reports
  `STOPPED` a single time, so the agent knows the user intervened. There is no
  timed lockout - the agent asks the user and continues;
- **one app or one browser tab** needs no confirmation, and the indicator adapts:
  - a soft DeepSeek-blue glow on the screen edges plus a gliding whale-cursor with
    a short English `intent` caption ("open settings") while the controlled window
    is in front — WPF with real per-pixel alpha, click-through (`HTTRANSPARENT`),
    auto-started per call, asleep after 5 minutes;
  - for browser tabs driven through `computer_cdp` the indicator lives **inside
    the browser**: the tab's own favicon is replaced by a composite of the original
    icon with the whale cursor on top (fetched, composited outside the browser, all
    `icon` links swapped), plus a `[DSH working]` title marker; both are restored
    when the work is done (a linger timer keeps the badge steady between
    back-to-back calls);
- captions, labels and tool text are English-only by design.

Design notes worth knowing:

- screenshots of a covered Chromium/Electron window are captured with
  `PrintWindow(PW_RENDERFULLCONTENT)`; ffmpeg's `gdigrab` records black for those;
- recordings are assembled from `PrintWindow` frames, because GPU-composited
  windows are invisible to `gdigrab`;
- occluded Chromium windows throttle timers and `requestIdleCallback`, so
  `computer_launch` can start a browser parked at `-6000,-6000` where it is fully
  scriptable but never covers the user's work;
- free text travels through a UTF-8 file, so quotes, backticks and Cyrillic survive
  PowerShell command-line parsing.

## `artifact-panes` in detail

- one source of truth for the panel width during a gesture (a CSS variable on the
  frame), so React is untouched until release;
- the release commits through a deferred native setter (idle/visibility/interaction),
  which keeps the expensive React re-render out of the pointer gesture;
- keyboard and double-click behaviours follow the host's own divider contract
  (min 340 px, `min(720, 75% · (innerWidth − sidebar))`, double click resets);
- the effect layer is a narrow column that travels with the divider — a blue guide
  when widening, red when narrowing.

## Install

Both plugins are ordinary DSH profile bundles. In the profile that should use them:

```sh
pnpm add dsh-computer-use dsh-artifact-panes
```

and add the bundle ids to `dsh.profile.bundles` in the profile's `package.json`.
The computer-use plugin pulls its PowerShell engine and CDP helper from inside its
own package, so nothing else has to be installed.

Requirements: Windows 10/11 for the computer-use engine (UI Automation, `PrintWindow`,
`Windows.Media.Ocr`), Node.js for the CDP helper, `ffmpeg` on `PATH` for clip
encoding, Chrome/Edge for the browser tools.

## Verification

The computer-use package ships the suites we gate changes on:

```sh
node tools/contract.mjs      # cordis contract: inject(['tools']) → 20 registrations
node tools/real-schema.mjs   # definitions accepted by the real @deepseek-ai/dsh-tools
node tools/verify.mjs --live # catalogue, argument mapping, engines, occlusion-proof shot
node tools/text-safety.mjs   # free text with quotes, $(), backticks and Cyrillic
node tools/text-encoding.mjs # caption text survives a CP1251 round trip
node tools/consent.mjs       # REFUSED without user_ready, ESC stop marker, restore
node tools/inline-media.mjs  # screenshots carry an attachment and render an image block
node tools/scenario.mjs      # silent launch → navigate → background click/type → trace
node tools/live-tools.mjs    # background drag, frame recording, OCR, wait, clipboard, park
```

`real-schema.mjs` loads the host package extracted from the installed `app.asar`
(`node tools/asar.mjs extract …`), which catches schema mistakes before a restart.

## License

Private tooling of the author; treat it as MIT unless a file says otherwise.