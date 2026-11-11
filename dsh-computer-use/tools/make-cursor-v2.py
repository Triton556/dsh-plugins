# Cursor sprite v2: the kit-whale head doubles as a pointer.
#
# Hotspot is the ear tip at the very top-left (2,2); the body widens down-right and
# the tail fluke closes the shape like an arrow's tail. Rendered at 4x and downsampled.
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 4
SIZE = 56
W = SIZE * SS

BLUE = (77, 107, 254, 255)
BLUE_DARK = (46, 68, 186, 255)
BELLY = (206, 222, 255, 255)
WHITE = (255, 255, 255, 255)
INK = (16, 20, 38, 255)
BLUSH = (255, 150, 172, 210)


def draw_v2():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = SS

    # tail fluke: closes the silhouette towards the bottom-right like an arrow tail
    d.polygon([
        (24 * k, 30 * k), (46 * k, 44 * k), (52 * k, 34 * k),
        (50 * k, 50 * k), (38 * k, 50 * k), (20 * k, 38 * k),
    ], fill=BLUE_DARK)

    # head: rounded mass whose upper-left corner is the hotspot
    d.rounded_rectangle((2 * k, 2 * k, 34 * k, 34 * k), radius=11 * k, fill=BLUE)
    # pointed ear that marks the tip
    d.polygon([(2 * k, 2 * k), (11 * k, 5 * k), (6 * k, 13 * k)], fill=BLUE)
    d.polygon([(17 * k, 4 * k), (25 * k, 1 * k), (26 * k, 10 * k)], fill=BLUE)
    d.polygon([(5 * k, 5 * k), (9 * k, 6 * k), (7 * k, 10 * k)], fill=BLUSH)
    d.polygon([(19 * k, 6 * k), (23 * k, 4 * k), (24 * k, 8 * k)], fill=BLUSH)

    # muzzle + eyes
    d.ellipse((8 * k, 20 * k, 30 * k, 34 * k), fill=BELLY)
    d.ellipse((10 * k, 12 * k, 18 * k, 21 * k), fill=WHITE)
    d.ellipse((22 * k, 12 * k, 30 * k, 21 * k), fill=WHITE)
    d.ellipse((13 * k, 15 * k, 17 * k, 20 * k), fill=INK)
    d.ellipse((25 * k, 15 * k, 29 * k, 20 * k), fill=INK)
    d.ellipse((14 * k, 16 * k, 15 * k, 17 * k), fill=WHITE)
    d.ellipse((26 * k, 16 * k, 27 * k, 17 * k), fill=WHITE)
    d.ellipse((18 * k, 23 * k, 22 * k, 26 * k), fill=INK)
    d.arc((14 * k, 24 * k, 26 * k, 32 * k), start=25, end=155, fill=INK, width=k)
    d.ellipse((7 * k, 24 * k, 12 * k, 28 * k), fill=BLUSH)
    d.ellipse((28 * k, 24 * k, 33 * k, 28 * k), fill=BLUSH)

    # fin
    d.ellipse((3 * k, 20 * k, 9 * k, 30 * k), fill=BLUE_DARK)
    return img


def with_outline(img, size=SIZE):
    out = img.resize((size, size), Image.LANCZOS)
    alpha = out.split()[3]
    edge = alpha.filter(ImageFilter.MaxFilter(3)).point(lambda v: 255 if v > 40 else 0)
    rim = Image.new("RGBA", out.size, (255, 255, 255, 255))
    rim.putalpha(edge.point(lambda v: int(v * 0.9)))
    return Image.alpha_composite(rim, out)


def main():
    out_dir = os.environ.get("OUT_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    os.makedirs(out_dir, exist_ok=True)
    sprite = draw_v2()
    for size in (40, 56):
        path = os.path.join(out_dir, f"cursor-kit-pointer-{size}.png")
        with_outline(sprite, size).save(path)
        print(path)


if __name__ == "__main__":
    main()