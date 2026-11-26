# DSH plugins

Plugins and tooling for **DeepSeek Harness (DSH)** — a desktop agent host. This
repository collects the bundles we actually run in the desktop profile, with their
engines and verification suites.

## What is inside

| package | what it does |
|---|---|
| [`dsh-computer-use`](dsh-computer-use/) | First-class tools for driving the desktop: windows, occlusion-proof screenshots, click/drag/type/hotkeys/scroll, focus, Chrome tabs, waits, clipboard, window control, silent launches, frame/video recording, OCR and UI Automation |
| [`dsh-browser-bridge`](dsh-browser-bridge/) | Browser automation over an MV3 extension and a native messaging host: accessibility snapshots and trusted input in an already running browser, without a debug port or a browser restart |
| [`artifact-panes`](artifact-panes/) | Artifact panel for the chat: tabs with HTML artifacts plus a draggable divider (blue when widening, red when narrowing) that snaps on release and commits the width outside the gesture |
| `dsh-claude-style` | Skin: typography, spacing and the mascot/ring indicators that make the desktop app read like a Claude-style workspace |
| [`docs/`](docs/) | Research notes, plan and stories for the GUI performance work, crash reports collected from the machine |
| [`tools/`](tools/) | Standalone helpers: `asar.mjs` (inspect any Electron `app.asar`), PowerShell computer-use engine, health/crash collectors |

Agents working in this repository: read [`AGENTS.md`](AGENTS.md) first. It carries
the working rules (research, design, approval, reporting) and the build/verify
steps for every package here.

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
park), `computer_launch` (optional off-screen start), and `computer_tabs` /
`computer_tab` (tab listing and selection through UI Automation).

**Browser automation** — use [dsh-browser-bridge](dsh-browser-bridge/) for
`browser_*` tools. The old `computer_cdp` tool is not part of this package.
Do not start a browser with a remote debugging port.

## On-screen indicator and consent

- Window-targeted pointer and keyboard input must still be in the foreground
  at dispatch. A pointer point must also hit the selected window; otherwise
  the tool reports the reason without sending input to a different window.
- Whole-screen input requires the user's confirmation via `user_ready: true`.
  The Windows indicator shows a desktop banner for the duration of the call.
- Window-targeted input uses a narrow halo around the active target, not around
  every monitor. Pointer tools mark the absolute dispatch point. Successful
  scoped actions have a short completion linger; failures and passive
  inspection do not leave the desktop banner up.
- The indicator is click-through and does not activate itself. ESC cancellation
  is handled by the Windows indicator daemon. Use semantic UIA actions where
  possible for interaction that does not move the real cursor.

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

Run the portable regression suites from the repository root:

```sh
node --test artifact-panes/test/*.test.mjs dsh-browser-bridge/test/*.test.mjs
node dsh-computer-use/tools/contract.mjs
node dsh-computer-use/tools/text-encoding.mjs
pwsh -NoProfile -File dsh-computer-use/tools/input-contract.ps1
```

For the isolated indicator contract and live Windows follow-up, see the
[plugin QA runbook](docs/qa/plugin-reliability.md). The PowerShell input
contract uses fake native symbols and sends no actual input.

## License

Private tooling of the author; treat it as MIT unless a file says otherwise.