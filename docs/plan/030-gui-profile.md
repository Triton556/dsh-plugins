# GUI profile report

Date: 2026-11-11. Two independent measurements, because the desktop window cannot be
attached to from outside.

## What was measured, and how

| target | channel | how |
|---|---|---|
| Web GUI (same app, web surface) | Chrome DevTools Protocol | `dsh --profile web --no-open` prints an authenticated URL; opened in a parked Chrome with `--remote-debugging-port` and anti-throttling switches; `tools/gui-profile.mjs` clicks a real session and steps the viewport width while tracing |
| Desktop GUI (Electron) | in-app instrumentation | LoAF observer + `COMMIT_PROFILE` inside the artifact plugin, driven by the drag self-test |

The desktop window loads the app over the private `dsh-app://` scheme, so it has
no HTTP surface to attach to; `http://127.0.0.1:PORT/` answers 401 without the
per-process token, which lives in the host's memory. The web surface is the only
CDP-reachable form of the same UI.

## Result 1 — web GUI, whole-app relayout (CDP, trustworthy)

Session: «Завершение staged fix и рестарт», 3656 DOM nodes, viewport 1600×913,
3 s of ±120 px width steps (the same relayout a panel resize performs).

```
frames 269   p50 24 ms   p95 48 ms   max 144 ms   frames > 50 ms: 10
phases: script 16401 ms · style/layout 2702 ms · paint 1536 ms · composite 78 ms
```

Script dominates, paint is cheap, frames land in the 24–48 ms band.

## Result 2 — desktop GUI, the divider commit (in-app)

From `COMMIT_PROFILE` and `LoAF` collected during self-test drags:

```
release -> commit call        1–5 ms
forced reflow after commit    4–105 ms (depends on what React re-renders)
frame containing the commit   ~210–230 ms (render ~90–100)
next frame (new layout)       330–440 ms (render 220–330)
```

## Conclusion

The same relayout costs 24–48 ms per frame in Chrome and 200–400 ms in Electron,
while script work is identical. The remaining cost is the Electron paint path
(GPU/compositing), not the page, the transcript or the plugin.

## To close the literal gap

Profiling a *divider drag* over CDP needs the desktop window attached, which needs
DSH started with `--remote-debugging-port=<port>`. Then the same script works with
the desktop port and a real handle drag instead of viewport steps.
## Result 3 — a real divider drag over CDP (the objective)

The web surface does have a right rail; it is simply closed. Clicking
«Открыть правую боковую панель» renders `[data-side="rightbar"]`, and the handle
can then be dragged with `Input.dispatchMouseEvent` exactly like a human would.

`node tools/divider-drag-trace.mjs 9513 -160 16` (drag the handle 160 px left):

| run | DOM | turns | frames | p50 | p95 | max | >50 ms |
|---|---|---|---|---|---|---|---|
| empty panel | 1351 | 0 | 16 | 32 ms | 35 ms | 35 ms | 0 |
| empty panel, reverse | 1351 | 0 | 16 | 28 ms | 35 ms | 35 ms | 0 |
| session loaded | 3404 | 93 | 16 | 30 ms | 53 ms | 53 ms | 1 |

Phases for the loaded-session drag (16 moves, 20 ms apart): script 1779 ms,
style/layout 274 ms, paint 172 ms, composite 4 ms, frames 103 ms.

Per move roughly 17 ms of style/layout and 11 ms of paint in Chrome.

## Comparison

Same operation, Electron window (in-app instrumentation): 200–400 ms per frame.
Chrome: 30–53 ms per frame. The page work is identical, so the remaining gap is
the Electron paint/compositing path — this is where the next optimisation round
should look.