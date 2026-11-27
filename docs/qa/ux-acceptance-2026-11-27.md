# DSH plugin UX evidence · 2026-11-27

Scope: disposable local fixtures with no personal account, browser profiles, or external model traffic.
The shipped code was tested on Linux plus Chrome Headless Shell 149.0.7827.22 and DSH Web 0.2.3-alpha.2.
Native Windows Computer Use and the installed Chrome MV3/native-host connection are separate acceptance gates.

| Plugin | What was verified here | Not verified here |
| --- | --- | --- |
| Browser Bridge | Production command dispatcher, Chrome API test adapter over a local pipe, real AX roles/values/bounds, iframe waits, Unicode, explicit clearing and keyboard, trusted click in A without altering B, navigation/stale AX, PNG/JPEG and release. Three additional automated regression cases. | Installation and live connection of the MV3 extension and its native host, Windows named pipe/registry, Chrome indicator or reconnect lifecycle. Full Chrome installed but its process singleton was rejected by this runner’s socket policy. |
| Computer Use | 19 tool registrations against DSH’s real schema library, foreground/point and Escape checks using fakes, capture backend and crop validation, GIF/MP4 contracts. Linux FFmpeg produced three real files from two synthetic frames each. | Live Windows clicking, drag release, WPF indicator, DPI/negative-origin monitor geometry, OCR and multi-process interaction. |
| Artifact Panes | 11 live Chrome Web assertions with a loopback provider: sandboxed iframe and real input, resize without losing state, live reload, annotation create/edit/submit, and two-chat isolation; five checks for restoring selections and a separate survey draft/remount/send scenario. | Native screenshot capture and desktop build. Restoring a chosen file does not restore the state of a destroyed iframe, by design. |
 
## Evidence

- [Browser Bridge step assertions](evidence/2026-11-27/browser-bridge.json) and [real fixture after click](evidence/2026-11-27/browser-bridge-click.jpg). The click was a real page event; the native extension layer was not loaded.
- [Computer Use portable results](evidence/2026-11-27/computer-use.txt) and [video contact sheet](evidence/2026-11-27/computer-use-reel-frames.jpg). The contact sheet is an explanation of the results, not filmed Windows UI.
- [Artifact Panes live checks](evidence/2026-11-27/artifact-panes.json) and [real annotation send](evidence/2026-11-27/artifact-panes-send.jpg). The fake loopback provider never contacted an external model. A later round [verified picker restoration](evidence/2026-11-27/artifact-picker-return.json), including independently selected files in A/B and removal of the selected file, without retaining the previous iframe.

## Further UX work

1. **Browser Bridge:** show connection health by layer, require snapshot generation with AX indices, and report whether expected postconditions were observed after input. An uncertain outcome must not cause the action to be replayed.
2. **Computer Use:** return original screenshot size, origin, crop offset and attachment scale so input coordinates can be derived reliably. Verify real focus, cancellation and the indicator against two harmless Notepad windows at 100%/150% DPI before changing visuals again.
3. **Artifact Panes:** give each pending or deferred action an explicit state and original chat; add keyboard traversal and focus return for the picker. Use real two-chat tests for switching, annotations and capture isolation, and distinguish a local draft from a sent annotation.

These proposals are not implemented as new features here. See the [portable verification commands and Windows checklist](plugin-reliability.md). Codex and Claude are design references, not measured parity.

## Required before merge

- Use a disposable Windows 11 VM with an unlocked interactive desktop, not just a service or a build runner. Use a new Chrome profile with no accounts, load the unpacked extension and register the native host there. Repeat the two-tab fixture through DSH's installed Bridge and verify reconnects, the Chrome attachment notice, and no replay after lost acknowledgement.
- Use two disposable Windows windows with different counter targets. Validate the blue border and pointer timing before, during and after real dispatch, foreground refusal and overlap, Esc in the middle of drag, no stuck mouse button, screenshot and OCR, and 100%/150% DPI on two displays including negative origin. Record using independent desktop capture, not just a window-only video.
- Reproduce the live Artifact Panes workflow in the Windows desktop host, including screenshot attachment and the chat-switch capture guard; distinguish a saved draft from actual submission. Use a fake local model endpoint. Do not frame the Linux recording as Windows evidence.
