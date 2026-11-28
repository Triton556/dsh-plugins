# Computer Use: window screenshots and action receipts

This slice keeps the existing Windows driver, permission logic, and overlay
paint gate. The existing tool result renderer shows a compact foreground
action receipt with the requested target and delivery status. It does not
register a new chat component, claim visual verification, or add a new Stop
button. The live overlay retains its Escape cancellation.

| Step | Contract |
| --- | --- |
| Window screenshot (PrintWindow) | Same PNG/attachment plus window-relative source crop and a single-use frame_id if the native geometry can be verified. Actual attachment dimensions, if available, give independent X/Y conversion. |
| Click or drag with frame_id | Same window/pid selector and window-relative coordinates are required. The points must be within the observed source crop. Worker checks HWND, owner/thread, process start, title, window rect and effective DPI before focusing and again before input. |
| Stale/changed frame | Refuse; take a new shot. No switch to foreground from an alternate mode and no fallback to desktop or an unguarded replay. |
| Input sent | Native press path reached and returned normally. Read current UI to verify effect. A failure after dispatch begins may mean partial input. |

The handle is short-lived, scoped to the tool registration, consumed once, and
does not replace consent. Legacy calls without a frame_id remain supported for
points from sources other than a window screenshot. Whole-desktop or visible
pixel captures do not issue a frame ID. The check is **not** an image
equivalence guarantee: animation or content within a window can change without
changing its geometry or title. Use current UIA data or a new observation if
the interface changes. Native checks bracket the focus/indicator wait and
pointer move, but cannot make OS state atomic with an input event.

The isolated Windows recording job exercises the real PowerShell/WPF stack
against a WinForms fixture. It bypasses plugin invalidation to move the window
in a separate native call, requires zero fixture events for the old frame, one
press/release for a fresh crop, and no events on reuse. This is not a signed
Desktop model-dispatch, mixed-DPI, or overlay crash recovery test. Local
contracts independently check scope, source crop, mapping, and receipt text.
