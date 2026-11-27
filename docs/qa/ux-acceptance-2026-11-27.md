# DSH plugin UX evidence · 2026-11-27

Scope: disposable local fixtures with no personal account, browser profiles, or external model traffic.
The shipped code was tested on Linux plus Chrome Headless Shell 149.0.7827.22 and DSH Web 0.2.3-alpha.2.
The table below describes the original Linux lab. The separate Windows follow-up is documented underneath.

| Plugin | What was verified here | Not verified here |
| --- | --- | --- |
| Browser Bridge | Production command dispatcher, Chrome API test adapter over a local pipe, real AX roles/values/bounds, iframe waits, Unicode, explicit clearing and keyboard, trusted click in A without altering B, navigation/stale AX, PNG/JPEG and release. Three additional automated regression cases. | Installation and live connection of the MV3 extension and its native host, Windows named pipe/registry, Chrome indicator or reconnect lifecycle. Full Chrome installed but its process singleton was rejected by this runner’s socket policy. |
| Computer Use | 19 tool registrations against DSH’s real schema library, foreground/point and Escape checks using fakes, capture backend and crop validation, GIF/MP4 contracts. Linux FFmpeg produced three real files from two synthetic frames each. | Live Windows clicking, drag release, WPF indicator, DPI/negative-origin monitor geometry, OCR and multi-process interaction. |
| Artifact Panes | 11 live Chrome Web assertions with a loopback provider: sandboxed iframe and real input, resize without losing state, live reload, annotation create/edit/submit, and two-chat isolation; five checks for restoring selections and a separate survey draft/remount/send scenario. | Native screenshot capture and desktop build. Restoring a chosen file does not restore the state of a destroyed iframe, by design. |
 
## Evidence

- [Browser Bridge step assertions](evidence/2026-11-27/browser-bridge.json) and [real fixture after click](evidence/2026-11-27/browser-bridge-click.jpg). The click was a real page event; the native extension layer was not loaded.
- [Computer Use portable results](evidence/2026-11-27/computer-use.txt) and [video contact sheet](evidence/2026-11-27/computer-use-reel-frames.jpg). The contact sheet is an explanation of the results, not filmed Windows UI.
- [Artifact Panes live checks](evidence/2026-11-27/artifact-panes.json) and [real annotation send](evidence/2026-11-27/artifact-panes-send.jpg). The fake loopback provider never contacted an external model. A later round [verified picker restoration](evidence/2026-11-27/artifact-picker-return.json), including independently selected files in A/B and removal of the selected file, without retaining the previous iframe.

## Native Windows follow-up

[Windows Server 2025 run #5](https://github.com/Triton556/dsh-plugins/actions/runs/45937209348/job/140303071385) tested `f48af7c2e8ea96a805b9fe24cd56454cbae95399` with one interactive 1024×768 display. It used synthetic pages and windows, a fresh Chrome for Testing 149.0.7827.22 profile and no personal accounts or model calls.

- **Browser Bridge:** the real MV3 worker launched the built C# host via native messaging with the installed registry entry. Requests used the shipped Bridge CLI over the real Windows named pipe. An actual trusted click reached A once, never B. An empty value cleared A only. The foreground PNG, stale-index rejection after navigation, release, and reconnection after browser restart passed. This does not test the full installed DSH tool invocation.
- **Computer Use:** the real PowerShell engine clicked a WinForms button exactly once in A, never B; a 70×50 window-relative crop had the expected color. An independent layered desktop capture measured the real blue WPF border (blue channel 0 to 89) without stealing focus. During a real drag, an automated Escape key event made the WPF daemon signal cancellation. The worker exited as stopped, Windows reported the mouse button released, and the frame disappeared. This tested one display and used a synthetic overlay state rather than the complete DSH Desktop orchestration.
- **Open defect:** `Page.captureScreenshot` on an inactive tab passed once but timed out at 25 seconds in two other headed Chrome runs. [Passing background sample](https://github.com/Triton556/dsh-plugins/actions/runs/45936848010) · [timed-out sample](https://github.com/Triton556/dsh-plugins/actions/runs/45937016917). Run #5 logs the background failure as an open release gate rather than failing unrelated foreground/native acceptance. Until addressed, activate the intended tab yourself before asking for a capture. Do not silently focus a different tab or fall back to its pixels.

### Inactive screenshot recovery

[Windows run #6](https://github.com/Triton556/dsh-plugins/actions/runs/45942229239/job/140318892953) on `a62e83c` decoded and checked the pixels, not just the PNG header:

| Scenario | Measured result |
| --- | --- |
| Active A before/after recoloring | Correct original/current pixels, 102/99 ms |
| A shown, then B selected | Actionable refusal in 2,086 ms; no file and no tab switch |
| A separate tab opened without selection | Correct pixels in 129 ms; no tab switch |

The extension now bounds the capture command (2 s inactive, 6 s active), rejects loading or unloaded pages without activating them, and verifies the same tab/document before returning pixels. A same-URL reload and a tab switch during capture are covered by extension regression tests. All nine extension tests passed on Windows; 24/24 combined portable Node tests passed locally. The prior WPF/drag/Escape fixture also passed again.

A quick refusal with a manual recovery is intentional when Chrome cannot render that tab. This is not a guarantee that all inactive tabs can be captured. Retest this contract through the installed DSH host and retail Chrome before production acceptance.

### Packaged Desktop and DPI diagnostics

[Signed installer test](https://github.com/Triton556/dsh-plugins/actions/runs/45948254963/job/140337840027): DeepSeek's Windows x64 download passed Authenticode verification; installed executable reported `0.2.2.0`. A clean Desktop profile initialized on first launch. The installed `dsh.cmd`, not the npm CLI, added all three exact QA tarballs. Their package names were present both in dependencies and the enabled bundle graph, and the signed application reopened. This establishes the packaged install and profile path, not tool dispatch.

[Native DPI check](https://github.com/Triton556/dsh-plugins/actions/runs/45948672324/job/140339168722): Computer Use now reports the selected HWND's effective DPI and awareness rather than a registry estimate. The live one-screen WinForms fixture reported `96` and `unaware`, matching the independent Win32 read. The click, crop, frame and automated Escape checks passed again. Input geometry has not changed. For mixed-DPI acceptance use a per-monitor-aware test app, verify actual 96 and 144 readings on the two displays (including negative origin), and then check pointer, crop and frame placement as the same window moves across them.

[Desktop UI follow-up](https://github.com/Triton556/dsh-plugins/actions/runs/45955074767/job/140359553387): reached **New session** through **Add API Key → Set up later**, then opened **Plugins** in the unmodified signed application. The default page has an **Installed plugins** section, not a separate **Installed** tab. After scrolling, the automated test independently confirmed all three visible cards below that section. [Native Windows screenshot](https://github.com/Triton556/dsh-plugins/actions/runs/45955074767/artifacts/15178292826) shows all three toggles on; the image was decoded and reviewed. A prior red run was a locator error (optional tab and an offscreen match), not a missing package. No credentials, experimental Discover bundle, model calls, tool dispatch or live Artifact Panes workflow were used.

### Artifact Panes: annotation capture source

[Signed Windows rerun](https://github.com/Triton556/dsh-plugins/actions/runs/45961562179/job/140380337872) confirmed the installed helper's bytes matched the QA script. The real app produced a 215 × 70 crop showing its Plugins heading; [both PNGs](https://github.com/Triton556/dsh-plugins/actions/runs/45961562179/artifacts/15180214225) are from the isolated Windows run. A separate Windows contract supplied a mocked unavailable capture and verified an explicit failure, exactly one attempt and no PNG. A known target produced the requested 20 × 18 crop. The helper never substitutes desktop pixels and does not restore a minimized window or guess among multiple candidates.

The annotation-renderer regression verified that a failed capture keeps the note and displays **Annotation saved without a screenshot**. All 11 Artifact Panes Node suites passed locally. The isolated Windows run tested the installed native helper directly, not a complete annotation flow through the signed Desktop UI.

## Further UX work

1. **Browser Bridge:** show connection health by layer, require snapshot generation with AX indices, and report whether expected postconditions were observed after input. An uncertain outcome must not cause the action to be replayed.
2. **Computer Use:** return original screenshot size, origin, crop offset and attachment scale so input coordinates can be derived reliably. Verify real focus, cancellation and the indicator against two harmless Notepad windows at 100%/150% DPI before changing visuals again.
3. **Artifact Panes:** give each pending or deferred action an explicit state and original chat; add keyboard traversal and focus return for the picker. Use real two-chat tests for switching, annotations and capture isolation, and distinguish a local draft from a sent annotation.

These proposals are not implemented as new features here. See the [portable verification commands and Windows checklist](plugin-reliability.md). Codex and Claude are design references, not measured parity.

## Required before merge

- Use a disposable Windows 11 VM with an unlocked interactive desktop, not just a service or a build runner. Use a new Chrome profile with no accounts, load the unpacked extension and register the native host there. Repeat the two-tab fixture through DSH's installed Bridge and verify reconnects, the Chrome attachment notice, and no replay after lost acknowledgement.
- Use two disposable Windows windows with different counter targets. Validate the blue border and pointer timing before, during and after real dispatch, foreground refusal and overlap, physical Escape in the middle of a drag (the automated key path passed separately), screenshot and OCR, and 100%/150% DPI on two displays including negative origin. Record using independent desktop capture, not just a window-only video.
- Now that signed Desktop installation and workspace entry are verified, reproduce the live Artifact Panes workflow in the Windows desktop host, including screenshot attachment and the chat-switch capture guard; distinguish a saved draft from actual submission. Use a fake local model endpoint. Do not frame the Linux recording as Windows evidence.

### Follow-up: annotation images stay in the originating project

- [Routing fix](https://github.com/Triton556/dsh-plugins/commit/b907a999be50c2d32be55b690636a1b1dd77402c): capture writes to the exact live session, and both pending and transcript thumbnails read from the exact owner session. A closed session can still read from its matching persisted workspace. An unresolved session never falls back to another project. Existing correctly stored PNGs still load; PNGs previously written into a different project are not moved or guessed at.
- **12/12 portable tests passed.** The new routing test executes real host routes and filesystem reads/writes in two disposable directories; it replaces only the native capture process with a known PNG. It checks B as the newer session, the absence of A's image in B, stable A reads, and A after closure. The client contract checks that previously sent notes use the transcript owner's session without altering the annotation message format.
- **Live DSH Web in Chrome:** created sessions in two distinct workspaces, opened A's artifact with real clicks, saved its annotation, switched to B and back, then sent the annotation and verified its thumbnail in the transcript. The PNG was a synthetic stand-in at the Windows-only capture boundary; the thumbnail fetch was through the actual plugin. No external model was used.
- [Windows routing and package job](https://github.com/Triton556/dsh-plugins/actions/runs/45969516720/job/140406216431): covers the routing and capture contracts and the signed Desktop package check, not the full annotation gesture in the signed Windows UI.

### Follow-up: scroll-anchored pins and the annotation toggle

- [Picker fix](https://github.com/Triton556/dsh-plugins/commit/6905814eb9fc22c971294275f961bdb7d6c3d28f): number pins resolve to live elements inside the owning artifact and update on the next animation frame during scroll and resize. Clipped or absent targets do not leave a floating pin. Marker lists stay in the correct artifact; hidden/reloaded pane cleanup no longer masquerades as a user pressing Esc.
- Exact installed QA bundle, live DSH Web in Chrome: wheel scrolling moved pin and target together by 38 px in a nested scroller and 45 px at document level. Clipping hid the pin, and returning restored it at its original spot. One toolbar button passed click, keyboard activation, Esc inside the iframe, and a second click to turn off. The active state shows one instruction banner. Reviewed the decoded 17-second screen recording with the pane enlarged; this is not native Windows footage. Portable suites: 12/12.
