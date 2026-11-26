"""Tiny SVG chart helpers. No plotting library, no dependencies.

Every figure is a string of SVG, so it stays crisp, prints, and can be inspected as
text. Coordinates are in CSS pixels; the viewBox equals the drawing size.

    from svg_chart import Doc
    d = Doc(940, 400, title="Bricks over capacity", subtitle="per pass")
    d.axes(x=range(64), y_max=900, x_label="pass", y_label="count")
    d.area_line(ys, colour=HOT)
    open("out.svg", "w").write(str(d))

Rules the helpers encode (see SKILL.md): one scale per comparison, ticks rounded to
human numbers, units written on the axis, a log axis that says it is log.
"""
import math

INK, DIM, FAINT = "#e7ecf2", "#9aa7b6", "#6f7d8c"
GRID, BG = "#2b333d", "#0e1114"
HOT, WARM, GOOD, COOL, VIOLET = "#ff6b57", "#f0a445", "#43c08a", "#4aa8ff", "#a97bff"


def nice_ticks(vmax, count=5):
    """Rounded tick values: 0, 225, 450 ... never 0, 202, 405."""
    if vmax <= 0:
        return [0]
    raw = vmax / count
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        step = m * mag
        if step >= raw:
            break
    out, v = [], 0.0
    while v <= vmax * 1.0001:
        out.append(round(v, 10))
        v += step
    return out


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Doc:
    def __init__(self, w, h, title="", subtitle="", bg=BG):
        self.w, self.h, self.parts = w, h, []
        self.parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
                          f'style="width:100%;height:auto;display:block">')
        self.parts.append(f'<rect width="{w}" height="{h}" fill="{bg}"/>')
        if title:
            self.text(26, 30, title, 19, INK, bold=True)
        if subtitle:
            self.text(26, 54, subtitle, 12, DIM)

    # ---------- primitives ----------
    def text(self, x, y, s, size=12, fill=DIM, bold=False, anchor="start", family="Segoe UI"):
        weight = ' font-weight="600"' if bold else ""
        self.parts.append(f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size}"'
                          f'{weight} fill="{fill}" text-anchor="{anchor}">{esc(s)}</text>')

    def line(self, x1, y1, x2, y2, colour=GRID, width=1, dash=None, opacity=1):
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                          f'stroke="{colour}" stroke-width="{width}" opacity="{opacity}"{extra}/>')

    def rect(self, x, y, w, h, fill, stroke=None, width=1):
        s = f' stroke="{stroke}" stroke-width="{width}"' if stroke else ""
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{fill}"{s}/>')

    def polyline(self, pts, colour=HOT, width=2, fill="none"):
        p = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        self.parts.append(f'<polyline points="{p}" fill="{fill}" stroke="{colour}" stroke-width="{width}"/>')

    def polygon(self, pts, fill, stroke=None, width=1):
        p = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        s = f' stroke="{stroke}" stroke-width="{width}"' if stroke else ""
        self.parts.append(f'<polygon points="{p}" fill="{fill}"{s}/>')

    # ---------- chart parts ----------
    def axes(self, x_range, y_max, left=66, top=92, right=30, bottom=62,
             x_label="", y_label="", log=False, x_ticks=None):
        """Draw the frame, ticks and labels; keep pw/ph for the caller."""
        self.pw = self.w - left - right
        self.ph = self.h - top - bottom
        self.left, self.top = left, top
        self.x0, self.x1 = x_range[0], x_range[1]
        self.y_max = y_max
        self.log = log
        vals = nice_ticks(y_max)
        for v in vals:
            y = self.y(v)
            self.line(left, y, left + self.pw, y)
            label = f"{v:g}" + ("×" if log else "")
            self.text(18, y + 4, label, 11, FAINT, family="Consolas")
        for x in (x_ticks if x_ticks is not None else _default_x(x_range)):
            self.text(self.x(x) - 6, top + self.ph + 20, f"{x:g}", 11, FAINT, family="Consolas")
        if x_label:
            self.text(left, self.h - 22, x_label, 12, FAINT)
        if y_label:
            self.text(18, top - 22, y_label, 11, FAINT)
        return self

    def x(self, v):
        return self.left + (v - self.x0) / (self.x1 - self.x0) * self.pw

    def y(self, v):
        if self.log:
            lo, hi = 1.0, max(self.y_max, 1.0001)
            t = (math.log10(max(v, lo)) - math.log10(lo)) / (math.log10(hi) - math.log10(lo))
            return self.top + self.ph - t * self.ph
        return self.top + self.ph - self.ph * min(v, self.y_max) / self.y_max

    def area_line(self, xs, ys, colour=HOT, fill="#2c1f1e"):
        pts = [(self.x(x), self.y(y)) for x, y in zip(xs, ys)]
        self.polygon([(pts[0][0], self.top + self.ph)] + pts + [(pts[-1][0], self.top + self.ph)], fill)
        self.polyline(pts, colour, 2)
        return pts

    def note(self, x, y, s, colour=HOT):
        """A value written on the picture, not in a legend across the page."""
        self.text(x, y, s, 12, colour, bold=True)

    def __str__(self):
        return "".join(self.parts) + "</svg>"


def _default_x(rng):
    lo, hi = rng
    step = nice_ticks(hi, 6)[1] if len(nice_ticks(hi, 6)) > 1 else 1
    out, v = [], lo
    while v <= hi:
        out.append(v)
        v += step
    return out


def timeline(doc, rows, left=118, top=92, row_height=30, gap=112, x_max=None,
             label_width=90, frame_colour=None, busy_colour=HOT):
    """Gantt-style frames: one rect per frame, a bracket for the unresponsive span.

    rows: [{"label": str, "frames": [{"x": ms, "ms": ms, "changed": bool}],
            "busy": (start_ms, end_ms), "caption": str}]
    """
    frame_colour = frame_colour or GRID
    x_max = x_max or max(r["frames"][-1]["x"] + r["frames"][-1]["ms"] for r in rows)
    scale = (doc.w - left - 26) / x_max
    for i, r in enumerate(rows):
        y0 = top + i * gap
        doc.text(26, y0 + 8, r["label"], 13, INK, bold=True)
        for f in r["frames"]:
            doc.rect(left + f["x"] * scale, y0, max(1.2, f["ms"] * scale - 0.4), row_height,
                     GOOD if f.get("changed") else frame_colour)
        b0, b1 = r["busy"]
        doc.line(left + b0 * scale, y0 - 14, left + b1 * scale, y0 - 14, busy_colour, 3)
        for bx in (b0, b1):
            doc.line(left + bx * scale, y0 - 18, left + bx * scale, y0 + row_height, busy_colour)
        doc.text(left + b1 * scale + 8, y0 - 20, f"{b1 - b0:.0f} мс", 12, busy_colour,
                 bold=True, family="Consolas")
        if r.get("caption"):
            doc.text(left, y0 + row_height + 18, r["caption"], 12, HOT)
        doc.line(left, y0 + row_height, left + x_max * scale, y0 + row_height, GRID)
    return doc


if __name__ == "__main__":
    d = Doc(940, 400, "Demo chart", "values come from data, ticks are rounded")
    d.axes((0, 63), 900, x_label="pass", y_label="count")
    ys = [min(900, 12 * i * (1.35 ** (i / 9))) for i in range(64)]
    d.area_line(range(64), ys)
    d.note(d.x(20) + 8, d.y(ys[20]) - 10, f"{int(ys[20])} over capacity")
    open("demo-chart.svg", "w", encoding="utf-8").write(str(d))
    print("wrote demo-chart.svg", len(str(d)), "bytes; ticks:", nice_ticks(900))
