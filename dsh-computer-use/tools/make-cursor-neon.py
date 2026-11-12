# Neon cursor sprite: rounded pointer with a soft halo, DeepSeek blues only.
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 6
SIZE = 44
W = SIZE * SS

SHAPE = [(1, 1), (1, 20), (6, 15), (10, 24), (13, 22), (9, 14), (16, 14)]


def scaled(points, k, pad):
    return [(x * k + pad, y * k + pad) for (x, y) in points]


def render(size=SIZE):
    k = SS * (size / 22.0)
    pad = int(3 * k)
    canvas = int(22 * k + pad * 2)
    base = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    pts = scaled(SHAPE, k, pad)

    # soft outer halo (blurred copy of the silhouette)
    halo = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.polygon(pts, fill=(122, 145, 255, 220))
    halo = halo.filter(ImageFilter.GaussianBlur(radius=k * 2.2))
    base = Image.alpha_composite(base, halo)

    # mid halo, tighter
    mid = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    md = ImageDraw.Draw(mid)
    md.polygon(pts, fill=(150, 174, 255, 235))
    mid = mid.filter(ImageFilter.GaussianBlur(radius=k * 0.9))
    base = Image.alpha_composite(base, mid)

    # body with a bright rim: draw a thick light outline, then the blue fill inside
    body = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.polygon(pts, fill=(214, 226, 255, 255))
    inner = [(x + (y - pad) * 0.0, y) for (x, y) in pts]  # placeholder to keep tuple shape
    # shrink towards the centroid for the inner fill
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    shrink = 0.72
    inner_pts = [(cx + (x - cx) * shrink, cy + (y - cy) * shrink) for (x, y) in pts]
    bd.polygon(inner_pts, fill=(77, 107, 254, 255))
    base = Image.alpha_composite(base, body)

    return base.resize((size, size), Image.LANCZOS)


def main():
    out_dir = os.environ.get("OUT_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    os.makedirs(out_dir, exist_ok=True)
    img = render()
    for size in (44, 64):
        path = os.path.join(out_dir, f"cursor-neon-{size}.png")
        render(size).save(path)
        print(path)


if __name__ == "__main__":
    main()