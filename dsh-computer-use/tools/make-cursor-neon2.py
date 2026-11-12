# Neon pointer sprite modelled on the reference image: thick rounded outline,
# bright rim, inner gradient, soft outer glow. All blues (DeepSeek palette).
import os
from PIL import Image, ImageDraw, ImageFilter

SIZE = 72
SS = 6
W = SIZE * SS
PAD = 14 * SS

SHAPE = [(1, 1), (1, 21), (6.5, 15.5), (10.5, 25), (14, 23), (9.5, 14.5), (17, 14.5)]


def points(scale, pad):
    return [(x * scale + pad, y * scale + pad) for (x, y) in SHAPE]


def render(size=SIZE):
    scale = (W - PAD * 2 - 6 * SS) / 20.0
    canvas = (W, W)
    pts = points(scale, PAD)

    # outer glow: several blurred silhouettes stacked
    glow = Image.new("RGBA", canvas, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.polygon(pts, fill=(110, 136, 255, 255))
    for radius, alpha in ((scale * 3.2, 90), (scale * 1.8, 130), (scale * 0.7, 170)):
        layer = Image.new("RGBA", canvas, (0, 0, 0, 0))
        ImageDraw.Draw(layer).polygon(pts, fill=(120, 146, 255, alpha))
        glow = Image.alpha_composite(glow, layer.filter(ImageFilter.GaussianBlur(radius)))
    base = glow

    # silhouette outline (rounded): thick stroke with round joins
    rim = Image.new("RGBA", canvas, (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.line(pts + [pts[0]], fill=(226, 236, 255, 255), width=int(scale * 1.5), joint="curve")
    rd.polygon(pts, outline=(226, 236, 255, 255), width=int(scale * 1.5))
    base = Image.alpha_composite(base, rim)

    # body: vertical gradient from lighter top to the brand blue
    body = Image.new("RGBA", canvas, (0, 0, 0, 0))
    mask = Image.new("L", canvas, 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    grad = Image.new("RGBA", canvas, (0, 0, 0, 0))
    gd2 = ImageDraw.Draw(grad)
    top = (170, 192, 255)
    bottom = (77, 107, 254)
    y0 = min(p[1] for p in pts)
    y1 = max(p[1] for p in pts)
    for y in range(int(y0), int(y1) + 1):
        t = (y - y0) / max(1.0, (y1 - y0))
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        gd2.line([(0, y), (canvas[0], y)], fill=color)
    body.paste(grad, (0, 0), mask)
    base = Image.alpha_composite(base, body)

    # inner highlight stroke
    inner = Image.new("RGBA", canvas, (0, 0, 0, 0))
    ImageDraw.Draw(inner).line(pts + [pts[0]], fill=(238, 244, 255, 220), width=max(2, int(scale * 0.55)), joint="curve")
    base = Image.alpha_composite(base, inner)

    return base.resize((size, size), Image.LANCZOS)


def main():
    out_dir = os.environ.get("OUT_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    os.makedirs(out_dir, exist_ok=True)
    for size in (72, 96):
        path = os.path.join(out_dir, f"cursor-neon2-{size}.png")
        render(size).save(path)
        print(path)


if __name__ == "__main__":
    main()