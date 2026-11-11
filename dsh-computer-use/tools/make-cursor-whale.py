# DeepSeek whale-calf cursor sprite.
#
# The mascot is a whale, so the pointer is a small whale: nose at the top-left
# (hotspot), body widening down-right, fluke closing the silhouette like an arrow
# tail. Rendered at 4x and downsampled for smooth edges.
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 4
W = 56 * SS

BLUE = (77, 107, 254, 255)
BLUE_DEEP = (44, 66, 180, 255)
BELLY = (214, 228, 255, 255)
WHITE = (255, 255, 255, 255)
INK = (16, 20, 38, 255)


def draw_whale():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = SS

    # fluke: two lobes closing the shape to the bottom-right
    d.polygon([
        (26 * k, 28 * k), (50 * k, 40 * k), (43 * k, 47 * k),
        (52 * k, 50 * k), (38 * k, 54 * k), (22 * k, 38 * k),
    ], fill=BLUE_DEEP)
    # pectoral fin
    d.ellipse((8 * k, 30 * k, 20 * k, 38 * k), fill=BLUE_DEEP)

    # body: whale head, nose at the top-left
    d.rounded_rectangle((2 * k, 3 * k, 42 * k, 40 * k), radius=15 * k, fill=BLUE)
    # light belly
    d.ellipse((8 * k, 22 * k, 40 * k, 40 * k), fill=BELLY)
    # blowhole hint
    d.ellipse((20 * k, 6 * k, 24 * k, 9 * k), fill=BLUE_DEEP)
    # eye
    d.ellipse((13 * k, 14 * k, 24 * k, 25 * k), fill=WHITE)
    d.ellipse((16 * k, 17 * k, 21 * k, 22 * k), fill=INK)
    d.ellipse((17 * k, 18 * k, 18 * k, 19 * k), fill=WHITE)
    # muzzle line + smile
    d.arc((10 * k, 24 * k, 34 * k, 38 * k), start=15, end=140, fill=INK, width=k)
    d.ellipse((21 * k, 26 * k, 25 * k, 29 * k), fill=INK)
    # cheek
    d.ellipse((30 * k, 25 * k, 36 * k, 30 * k), fill=(255, 160, 178, 150))
    return img


def with_outline(img, size):
    out = img.resize((size, size), Image.LANCZOS)
    alpha = out.split()[3]
    edge = alpha.filter(ImageFilter.MaxFilter(3)).point(lambda v: 255 if v > 40 else 0)
    rim = Image.new("RGBA", out.size, (255, 255, 255, 255))
    rim.putalpha(edge.point(lambda v: int(v * 0.85)))
    return Image.alpha_composite(rim, out)


def main():
    out_dir = os.environ.get("OUT_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    os.makedirs(out_dir, exist_ok=True)
    whale = draw_whale()
    for size in (46, 64):
        path = os.path.join(out_dir, f"cursor-whale-{size}.png")
        with_outline(whale, size).save(path)
        print(path)


if __name__ == "__main__":
    main()