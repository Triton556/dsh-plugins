---
name: computer-use
description: Drive the desktop from an agent session — list windows, take occlusion-proof screenshots of a specific app, click/drag/type, switch Chrome tabs, read the clipboard, OCR, record frames, and use the Chrome DevTools Protocol. Use when a task needs a real GUI, a screenshot of another app, or profiling of a Chromium/Electron window.
---

# Computer use

Tools are registered by the `dsh-computer-use` bundle. Every tool returns
`{ ok, text }`; screenshots return a PNG **path** — read it with the image tool.

## The reliable loop

1. `computer_windows` — find the window by title/process.
2. `computer_shot` with `method: "print"` — captures the window **even when it is
   covered** by other apps (Chromium/Electron render themselves into a DC).
3. Act: `computer_click` / `computer_drag` / `computer_type` / `computer_key` /
   `computer_scroll`. With `window` given, coordinates are window-relative and
   the window is focused first.
4. Verify with another `computer_shot`.

Never raise a window just to look at it: `method: "print"` does not need focus.

## Recipes

**Screenshot only a region** (small image, less context):
`computer_shot { window, method: "print", x: 300, y: 100, width: 400, height: 200 }`

**Watch motion over time** (poor-man screen share, occlusion-proof):
`computer_record { window, frames: 12, interval: 150, dir: "C:/tmp/frames" }`
then read a few frames.

**Chrome tabs without touching the mouse**:
`computer_tabs` → title list; `computer_tab { title: "docs" }` selects it.

**Wait instead of polling**:
`computer_wait { window: "Claude", text: "Sign in", timeout: 15000 }`

**Non-ASCII typing**: `computer_type { text: "привет", unicode: true }`
(plain typing uses SendKeys and mangles non-ASCII).

**Read a console** without OCR: focus the window, `computer_key { text: "^a^c" }`,
then `computer_clipboard` and read the text.

**OCR** (canvas, video, games): `computer_ocr { path: "<png>" }` — Windows OCR,
no network.

## Chrome DevTools Protocol

Needs a Chromium/Electron started with `--remote-debugging-port=<port>`:

- `computer_launch { path: "C:/.../chrome.exe", args: "--remote-debugging-port=9222 --user-data-dir=C:/tmp/cdp-profile" }`
- `computer_cdp { action: "list" }` — targets
- `computer_cdp { action: "eval", expression: "document.title" }`
- `computer_cdp { action: "dom" }` — `document.body.outerHTML`
- `computer_cdp { action: "shot", path: "C:/tmp/tab.png" }` — tab pixels, never occluded
- `computer_cdp { action: "perf", duration: 3000 }` — frame timing p50/p95/max

CDP is the only way to profile our own GUI in a trustworthy way: window
screenshots are subject to Chromium throttling of occluded windows.

## Limits

- UI Automation trees of Electron apps are empty unless the app enables
  accessibility (`--force-renderer-accessibility`).
- `computer_focus` is best-effort: Windows foreground lock may refuse.
- Mouse/keyboard go to the real desktop — do not fight the human for the cursor.
## Working BEHIND other windows (no focus, no cursor)

Two paths, pick by app type.

**Chromium / Electron apps** (Chrome, our DSH, Claude Desktop): start them with a
debug port and drive them entirely in the background — no window raise, no
cursor movement, no focus steal:

```
computer_launch { path: "C:/.../chrome.exe",
                  args: "--remote-debugging-port=9333 --user-data-dir=C:/tmp/cdp" }
computer_cdp { port: 9333, action: "list" }
computer_cdp { port: 9333, action: "navigate", url: "https://example.com" }
computer_cdp { port: 9333, action: "eval", expression: "document.title" }
computer_cdp { port: 9333, action: "click", x: 98, y: 165 }      // real click in the page
computer_cdp { port: 9333, action: "eval", expression: "document.getElementById('i').focus()" }
computer_cdp { port: 9333, action: "type", text: "hello" }
computer_cdp { port: 9333, action: "key", keys: "ENTER" }
computer_cdp { port: 9333, action: "scroll", x: 400, y: 400, delta: -600 }
computer_cdp { port: 9333, action: "shot", path: "C:/tmp/tab.png" }
computer_cdp { port: 9333, action: "trace", path: "C:/tmp/trace.json", duration: 3000 }
```

Verified: clicks and typing land in the page while another app owns the
foreground, and the mouse pointer does not move. Type after focusing the field
(click it or `eval` a `.focus()`), because `Input.insertText` goes to the
focused element.

**Native apps** (Win32/WPF/UWP): use UI Automation patterns, which act on a
control without activating the window:

```
computer_uitree { window: "Notepad" }            // find the control name
computer_ui_action { window: "Notepad", name: "File", kind: "invoke" }
computer_ui_action { window: "Form", name: "Email", kind: "value", value: "a@b.c" }
```

Patterns tried in order: invoke → toggle → select → expand → value. Real mouse
input (`computer_click`) is the fallback and DOES need the window in front.
## Launch without covering the user

`computer_launch` takes `park: true`: Chromium gets `--window-position=-6000,-6000`
so its window is born off every monitor, and other apps are moved off-screen as
soon as the window appears. Verified: the window reports `-6000,-6000` and the
debug port still answers, so a parked browser remains fully scriptable.

```
computer_launch { path: "C:/.../chrome.exe", park: true,
                  args: "--remote-debugging-port=9471 --user-data-dir=C:/tmp/cdp-1 --window-size=1200,900 about:blank" }
computer_cdp { port: 9471, action: "list" }        // works while parked
```

End-to-end scenario (launch → navigate → background click → type → screenshot →
trace → park) is reproducible with `node tools/scenario.mjs`.