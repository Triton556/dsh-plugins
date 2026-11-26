---
name: data-reports
description: "Build visual reports that a human can actually read - choosing the right figure for the question, keeping it honest, verifying it as a person and iterating until it says what it claims. Use for any deliverable that explains measured or computed data (comparisons, breakdowns, timelines, durations, geometry, distributions, before/after states)."
---

# Data reports with figures

A report is not a dump of measurements; it is a claim made checkable. Everything
below serves that. Domain does not matter: the reader's task and the shape of the
data decide the form.

## 1. Start from the claim

Before any drawing, write one sentence the figure must prove, with a number:
"the frozen pose lasted 158 ms against 39 ms". If you cannot write it, you have no
figure yet. The caption repeats that sentence; the picture is its evidence.

## 2. Match the form to the reader's task

| The reader must be able to | Form | Anti-pattern |
|---|---|---|
| name what belongs to a category | colour coding plus a list or examples | a cloud where the category is unreadable |
| answer "where" | spatial view: plan, section, map; for a 3D body add a second view or rotation | a single raked view |
| get the order | sequence in time | bars without a time axis |
| compare magnitudes | shared scale, sorted, top-N | each series scaled on its own |
| see a trend | line or area, axis in physical units | a log axis without saying so |
| judge spread | a distribution, not a mean | one average with no interval |
| see a relation | scatter | a line through unconnected points |
| understand composition | shares inside one bar | pie charts, especially 3D |
| follow a process | step diagram or Gantt | boxes without time |
| see a trade-off | scatter with quadrants, or a table | one composite score |

If the reader must feel or hear the result (sound, motion, a shader), the artifact
itself belongs in the report; a chart goes beside it, never instead of it.

## 3. Pick the rendering under three constraints

- **Density.** Tens of elements: vector with labels. Thousands: raster or canvas,
  label only the conclusions. Tens of thousands: aggregates, never single elements.
- **Dimensionality.** One quantity is a chart. Two spatial axes are a plan. Three are
  an isometric or a rotating model, always with a plan or a second view.
- **Verifiability.** If a number must be checkable, the axes, ticks and values are on
  the picture. If only the conclusion matters, values may go, but the conclusion must
  be written on the figure.

## 4. Never lie

- Any comparison shares one scale. Two rows scaled independently lie by construction.
- Units on every axis; a logarithmic scale says so.
- Every value comes from a data file at build time. Never type points by hand: a
  hand-written polyline looks exact and is not evidence.
- Round the ticks; unrounded maxima read as noise.
- State the window: which rows, which run, which selection. A figure that silently
  drops data is a wrong figure.
- Say which check did not run. "Not verified" is a finding, not an omission.

## 5. Draw only what is visible

- Remove hidden surfaces; drawing all faces of a dense body turns into mush.
- An outline is a joint. Draw the edge of every exposed face to show coursing,
  panels or cells; without it a wall becomes a flat slab.
- One colour carries one meaning: order or identity, never both.
- Markers may go over geometry when counting matters more than occlusion; say so in
  the caption.

## 6. Projection

- One view of a solid lies. Side views collapse depth, so two things that never touch
  appear at the same place. Always add a plan, a section or rotation.
- Check the vertical direction **before** judging anything else: a mirrored axis still
  looks plausible. Verify with two known points (top of the model must be higher on
  screen than its base) and print the numbers.
- The same model at a different yaw is a different picture; decide the default angle
  once and keep it across figures of one report.

## 7. Look at what you ship

Never judge a figure you have not seen. Headless Chrome renders both static SVG/HTML
and pages with JavaScript, so the delivered artifact itself can be reviewed:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --hide-scrollbars --virtual-time-budget=5000 --window-size=1000,4000 `
  --screenshot="shot.png" "file:///F:/path/to/page.html"
```

`--virtual-time-budget` lets scripts, canvas drawing and layout settle; without it a
canvas comes out blank. Crop the region you are judging before looking at it, and look
at 1:1 — a downscaled view hides exactly the defects that matter (thin lines, overlaps,
clipped labels).

Before that renderer existed the fallback was: build the same mathematics as a raster,
look at it, then port to vector. Keep that fallback for anything Chrome cannot render,
but prefer looking at the shipped file. If you cannot see it, you cannot judge it.

## 8. Delivery that cannot fail silently

- Put a self-check line in the page: `1612 faces, 63 seams, rotation 38°`. A blank
  element is a signal, and a wrong count is caught before the reader sees it.
- Syntax-check the delivered script; a page that throws leaves a blank box and no
  message.
- Wrap the page script so a runtime error writes itself into that self-check line.
- Check the delivered file offline: element counts, payload parse, expected sections.

## 9. Review as a human

Six questions after the first build; rework while any answer is wrong:

1. What do I see in three seconds, without reading the caption?
2. Where on the picture is the answer to the stated question — point at it.
3. What here lies, or is not in the data?
4. What can I not count or check here although I should?
5. What would I remove as noise?
6. Knowing nothing, which wrong conclusion would I draw?

Rules for the loop: at least one revision pass is expected — zero passes is
suspicious. Re-render after every fix and look again. Stop when a further change
would no longer change the reader's conclusion; cosmetic polish is not a reason to
keep iterating. Report what you changed and why, with the defects you found.

## 10. Assets

`assets/svg_chart.py` — axes, ticks, area+line, event timeline, labels; emits SVG.
`assets/spatial.py` — cell occupancy, exposed faces, axonometric projection with
depth, SVG output; the vertical axis is handled explicitly.
`assets/report.html` — a page skeleton: dark sections, `.stage` for media, a canvas
block with rotation controls and a self-check line.

Copy them and adapt; do not re-derive the projection or the tick code by hand.
