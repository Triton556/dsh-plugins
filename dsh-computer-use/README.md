# dsh-computer-use

First-class desktop control for DeepSeek Harness: window listing, occlusion-proof
screenshots, real mouse/keyboard input, Chrome tab switching, clipboard, OCR,
native UI Automation and frame recording.

Every tool returns `{ ok, text }`; screenshots and clips also carry an inline
attachment, so the chat shows the picture without a second tool call.

## What it registers

| Tool | What it does |
| --- | --- |
| `computer_windows` | Top-level windows: pid, process, title, size, hwnd |
| `computer_shot` | Window screenshot (`method: "print"`, works while covered) or a screen copy, optional region crop |
| `computer_click` | Click at a point; window-relative and focused when `window` is given |
| `computer_drag` | Press, move, release between two points |
| `computer_type` | Type text into the focused control (Unicode mode for non-ASCII) |
| `computer_key` | SendKeys combo, e.g. `^c`, `{ENTER}` |
| `computer_scroll` | Wheel scroll at a point |
| `computer_focus` | Best-effort window activation |
| `computer_window` | Move/resize/min/max/park/untopmost a window |
| `computer_wait` | Wait for a window or a UI element instead of polling |
| `computer_tabs` / `computer_tab` | List and select Chrome/Edge tabs over UI Automation |
| `computer_clipboard` | Read or set the clipboard |
| `computer_launch` | Start an app; `park: true` keeps it off every monitor |
| `computer_record` | Frame sequence of one window (occlusion-proof) |
| `computer_video` | Short clip of one window (mp4 or animated gif) |
| `computer_ocr` | Windows OCR, offline, for canvas/video frames |
| `computer_uitree` | UI Automation tree of a window, optionally filtered |
| `computer_ui_action` | Invoke/toggle/select/expand/set-value on a native control without activating the window |

## Install on another machine

1. Copy this folder, then add it to a profile bundle (it is already a `link:`
   dependency in Danil's profile). The bundle exposes `index.js` and
   `cordis.patch.yml`.
2. Requirements: Windows (PowerShell 5.1+), Node 20+ for the engine helpers.
3. The PowerShell engine (`tools/cua.ps1`) and the Node helpers in `tools/` are
   bundled with the package, so it stays portable.

## Notes

- Input tools that take over the whole screen need `user_ready: true`; a call
  addressed to one window does not.
- Coordinates with `window` are window-relative; without it they are screen
  coordinates.
- `computer_click` focuses the target window first. Windows that must not be
  raised should be driven through `computer_uitree` + `computer_ui_action`,
  which act on a control without activating anything.

## Silent launches

`computer_launch { park: true }` starts a Chromium with
`--window-position=-6000,-6000` and moves other apps off-screen as soon as their
window appears. A parked window still renders for `computer_shot`
(`method: "print"`), so it stays inspectable while never covering the user.

## Boot contract

After a restart the plugin appends one line to
`%TEMP%/dsh-computer-use.log`:

```
<ISO timestamp> pid=<pid> registered <n> tools
```

A missing line means the tools service was unavailable when the bundle applied.

## Verification suites

`tools/verify.mjs` checks the catalogue shape and that the packaged PowerShell
engine answers; `tools/scenario.mjs` exercises launch -> screenshot -> park. Both
run against the installed engine, no browser required.

## Screenshots and clips appear in the chat

`computer_shot` and `computer_video` return a file path, and the plugin attaches
the image (or the gif, or an mp4 poster frame) to the tool result, so the picture
appears inline.
