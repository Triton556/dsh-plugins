"""Axonometric rendering of a voxel body: occupancy, exposed faces, depth-sorted SVG.

The point of this module is to stop re-deriving the projection and, above all, to get
the vertical direction right: `screen_y` grows downward, so a higher world point must
produce a *smaller* `screen_y`. `check_orientation()` proves it with two model points
before anything is drawn.

Bricks are axis-aligned boxes (x, y, z, sx, sy, sz) in integer cells; y is up.
"""
import math

INK, DIM, FAINT = "#e7ecf2", "#9aa7b6", "#6f7d8c"
MORTAR = "#2e2c29"
TOP, LEFT, RIGHT = (214, 205, 187), (156, 147, 132), (112, 105, 95)
SE = 0.49                      # sine of the elevation angle (~29°)
CE = math.sqrt(1 - SE * SE)


def project(p, yaw_deg):
    """Return (screen_x, screen_y, depth). screen_y grows down; y is up in the model."""
    a = math.radians(yaw_deg)
    s, c = math.sin(a), math.cos(a)
    depth_axis = p[0] * s + p[2] * c
    return (p[0] * c - p[2] * s,          # right
            SE * depth_axis - CE * p[1],  # down-positive: a higher y gives a smaller value
            CE * depth_axis + SE * p[1])  # toward the camera


def check_orientation(yaw_deg=38.0, low=2.0, high=30.0):
    """Two points on one vertical line: the high one must sit above (smaller screen_y)."""
    a = project((15.5, high, 25.5), yaw_deg)[1]
    b = project((15.5, low, 25.5), yaw_deg)[1]
    assert a < b, f"vertical axis is mirrored: y={high} -> {a:.2f}, y={low} -> {b:.2f}"
    return round(a, 2), round(b, 2)


def occupancy(bricks):
    cells = set()
    for (x, y, z, sx, sy, sz) in bricks:
        for cx in range(x, x + sx):
            for cy in range(y, y + sy):
                for cz in range(z, z + sz):
                    cells.add((cx, cy, cz))
    return cells


def exposed_faces(bricks):
    """Only surfaces a camera can see: no interior faces, no doubled slabs."""
    occ = occupancy(bricks)

    def free(x, y, z, sx, sy, sz):
        for cx in range(x, x + sx):
            for cy in range(y, y + sy):
                for cz in range(z, z + sz):
                    if (cx, cy, cz) in occ:
                        return False
        return True

    faces = []
    for (x, y, z, sx, sy, sz) in bricks:
        cx, cy, cz = x + sx / 2, y + sy / 2, z + sz / 2
        if free(x, y + sy, z, sx, 1, sz):
            faces.append(dict(pts=[[x, y + sy, z], [x + sx, y + sy, z], [x + sx, y + sy, z + sz], [x, y + sy, z + sz]],
                              colour=TOP, centre=[cx, y + sy, cz]))
        if free(x + sx, y, z, 1, sy, sz):
            faces.append(dict(pts=[[x + sx, y, z], [x + sx, y + sy, z], [x + sx, y + sy, z + sz], [x + sx, y, z + sz]],
                              colour=RIGHT, centre=[x + sx, cy, cz]))
        if free(x, y, z + sz, sx, sy, 1):
            faces.append(dict(pts=[[x, y, z + sz], [x + sx, y, z + sz], [x + sx, y + sy, z + sz], [x, y + sy, z + sz]],
                              colour=LEFT, centre=[cx, cy, z + sz]))
    return faces


def shade(rgb, k):
    return f"rgb({min(255, int(rgb[0] * k))},{min(255, int(rgb[1] * k))},{min(255, int(rgb[2] * k))})"


def render_svg(faces, markers=(), yaw=38.0, w=940, h=620, pad=24, title="", subtitle=""):
    """Depth-sorted SVG. Markers are drawn last: counting them matters more than occlusion."""
    check_orientation(yaw)
    proj = lambda p: project(p, yaw)
    pts = [proj(p) for f in faces for p in f["pts"]]
    minx = min(p[0] for p in pts); maxx = max(p[0] for p in pts)
    miny = min(p[1] for p in pts); maxy = max(p[1] for p in pts)
    sc = min((w - 2 * pad) / (maxx - minx), (h - 90 - 2 * pad) / (maxy - miny))
    ox = pad + (w - 2 * pad - (maxx - minx) * sc) / 2 - minx * sc
    oy = 90 + pad - miny * sc

    def sp(p):
        x, y, d = proj(p)
        return x * sc + ox, y * sc + oy, d

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
           f'style="width:100%;height:auto;display:block"><rect width="{w}" height="{h}" fill="#0e1114"/>']
    if title:
        out.append(f'<text x="26" y="30" font-family="Segoe UI" font-size="19" font-weight="600" fill="{INK}">{title}</text>')
    if subtitle:
        out.append(f'<text x="26" y="54" font-family="Segoe UI" font-size="12" fill="{DIM}">{subtitle}</text>')
    items = [(sp(f["centre"])[2], "f", f) for f in faces] + [(sp(m[0])[2] + 1e-3, "m", m) for m in markers]
    items.sort(key=lambda it: it[0])
    for depth, kind, item in items:
        if kind == "f":
            poly = " ".join(f"{sp(p)[0]:.1f},{sp(p)[1]:.1f}" for p in item["pts"])
            out.append(f'<polygon points="{poly}" fill="{shade(item["colour"], 1.0)}" '
                       f'stroke="{MORTAR}" stroke-width="1"/>')
        else:
            (p, colour) = item
            x, y, _ = sp(p)
            r = 6
            out.append(f'<polygon points="{x:.1f},{y - r:.1f} {x + r:.1f},{y:.1f} {x:.1f},{y + r:.1f} {x - r:.1f},{y:.1f}" '
                       f'fill="{colour}" stroke="#12151a" stroke-width="1.4"/>')
    out.append("</svg>")
    return "".join(out)


if __name__ == "__main__":
    # A hollow 10x10 tower, 12 courses tall, with a doorway — enough to show coursing.
    bricks = []
    for cx in range(10):
        for cz in range(10):
            edge = cx in (0, 9) or cz in (0, 9)
            if not edge:
                continue
            for cy in range(12):
                if cx in (0, 9) and 4 <= cz <= 6 and cy < 5:
                    continue                      # doorway
                bricks.append([cx, cy, cz, 1, 1, 1])
    faces = exposed_faces(bricks)
    markers = [([5, 12, 0], "#a97bff"), ([0, 6, 5], "#ff6b57")]
    svg = render_svg(faces, markers, yaw=38, title="Axonometric demo",
                     subtitle="exposed faces only, mortar outline, markers on top")
    open("demo-3d.svg", "w", encoding="utf-8").write(svg)
    print("bricks", len(bricks), "faces", len(faces), "orientation", check_orientation())
