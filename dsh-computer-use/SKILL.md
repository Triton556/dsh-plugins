---
name: computer-use
description: Drive the desktop from an agent session - list windows, take occlusion-proof screenshots of a specific app, click/drag/type, switch Chrome tabs, read the clipboard, OCR, invoke native controls through UI Automation, and record frames. Use when a task needs a real GUI or a screenshot of another app.
---

# Computer use

Tools are registered by the `dsh-computer-use` bundle. Every tool returns
`{ ok, text }`; screenshots return a PNG **path** - read it with the image tool.

## The reliable loop

1. `computer_windows` - find the window by title/process.
2. `computer_shot` with `method: "print"` - captures the window **even when it is
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
`computer_tabs` -> title list; `computer_tab { title: "docs" }` selects it.

**Wait instead of polling**:
`computer_wait { window: "Claude", text: "Sign in", timeout: 15000 }`

**Non-ASCII typing**: `computer_type { text: "caf\u00e9", unicode: true }`
(plain typing uses SendKeys and mangles non-ASCII).

**Read a console** without OCR: focus the window, `computer_key { text: "^a^c" }`,
then `computer_clipboard` and read the text.

**OCR** (canvas, video, games): `computer_ocr { path: "<png>" }` - Windows OCR,
no network.

## Native windows without stealing focus

Use UI Automation patterns, which act on a control without activating the window:

```
computer_uitree { window: "Notepad" }            // find the control name
computer_ui_action { window: "Notepad", name: "File", kind: "invoke" }
computer_ui_action { window: "Form", name: "Email", kind: "value", value: "a@b.c" }
```

Patterns tried in order: invoke -> toggle -> select -> expand -> value. Real mouse
input (`computer_click`) is the fallback and DOES need the window in front, which
takes the pointer and the screen away from the user.

## Launch without covering the user

`computer_launch` takes `park: true`: Chromium gets `--window-position=-6000,-6000`
so its window is born off every monitor, and other apps are moved off-screen as
soon as the window appears. A parked window still renders for `computer_shot`
(`method: "print"`), so it stays usable without ever appearing on screen.

## Limits

- UI Automation trees of Electron apps are empty unless the app enables
  accessibility (`--force-renderer-accessibility`).
- Chromium throttles rendering for occluded and hidden windows: such a window can
  stop painting and stop exposing an accessibility tree until it is visible.
- `computer_focus` is best-effort: Windows foreground lock may refuse.
- Mouse/keyboard go to the real desktop - do not fight the human for the cursor.
