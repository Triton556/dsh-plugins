# Draw the DeepSeek "kit-whale" cursor sprite in a few variants.
#
# The sprite doubles as a pointer: the nose sits at the top-left corner (2,2), so the
# hotspot is the head and the tail trails down-right. Rendered at 4x and downsampled
# for smooth edges. Output: PNG files with transparency in the package shots folder.
import math
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 4                # supersampling factor
SIZE = 56             # final sprite size in px
W = SIZE * SS

BLUE = (77, 107, 254, 255)          # #4D6BFE brand
BLUE_DARK = (52, 76, 196, 255)
BELLY = (196, 214, 255, 255)
WHITE = (255, 255, 255, 255)
INK = (18, 22, 40, 255)


def canvas():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def rounded_body(d, box, color, radius_ratio=0.42):
    x0, y0, x1, y1 = box
    r = int(min(x1 - x0, y1 - y0) * radius_ratio)
    d.rounded_rectangle(box, radius=r, fill=color)


def variant_classic(with_ears=True, tail_fin=True, blush=False):
    img, d = canvas()
    k = SS
    # tail fluke trailing to the bottom-right
    if tail_fin:
        d.polygon([(30 * k, 34 * k), (52 * k, 50 * k), (40 * k, 52 * k), (26 * k, 46 * k)], fill=BLUE_DARK)
        d.polygon([(44 * k, 44 * k), (54 * k, 40 * k), (50 * k, 52 * k)], fill=BLUE_DARK)
    # body: whale blob with the nose at the top-left
    rounded_body(d, (6 * k, 8 * k, 42 * k, 40 * k), BLUE, 0.5)
    # belly
    d.ellipse((10 * k, 24 * k, 38 * k, 40 * k), fill=BELLY)
    # kitten ears on top of the head
    if with_ears:
        d.polygon([(12 * k, 10 * k), (16 * k, 1 * k), (23 * k, 8 * k)], fill=BLUE)
        d.polygon([(27 * k, 7 * k), (33 * k, 2 * k), (35 * k, 11 * k)], fill=BLUE)
        d.polygon([(15 * k, 8 * k), (17 * k, 4 * k), (21 * k, 8 * k)], fill=BELLY)
        d.polygon([(28 * k, 8 * k), (32 * k, 5 * k), (33 * k, 9 * k)], fill=BELLY)
    # eyes
    d.ellipse((15 * k, 16 * k, 23 * k, 25 * k), fill=WHITE)
    d.ellipse((27 * k, 16 * k, 35 * k, 25 * k), fill=WHITE)
    d.ellipse((18 * k, 19 * k, 22 * k, 23 * k), fill=INK)
    d.ellipse((29 * k, 19 * k, 33 * k, 23 * k), fill=INK)
    d.ellipse((19 * k, 20 * k, 20 * k, 21 * k), fill=WHITE)
    d.ellipse((30 * k, 20 * k, 31 * k, 21 * k), fill=WHITE)
    # nose + smile
    d.ellipse((23 * k, 26 * k, 27 * k, 29 * k), fill=INK)
    d.arc((20 * k, 27 * k, 32 * k, 35 * k), start=20, end=160, fill=INK, width=k)
    if blush:
        d.ellipse((12 * k, 26 * k, 18 * k, 31 * k), fill=(255, 158, 178, 190))
        d.ellipse((33 * k, 26 * k, 39 * k, 31 * k), fill=(255, 158, 178, 190))
    # fin
    d.ellipse((8 * k, 22 * k, 14 * k, 32 * k), fill=BLUE_DARK)
    return img


def variant_minimal():
    """Plain pointer silhouette with a whale tail and one eye: reads better at 24 px."""
    img, d = canvas()
    k = SS
    body = [
        (6 * k, 4 * k), (26 * k, 20 * k), (20 * k, 24 * k), (30 * k, 36 * k),
        (24 * k, 38 * k), (34 * k, 48 * k), (30 * k, 52 * k), (16 * k, 34 * k),
        (12 * k, 40 * k), (6 * k, 34 * k),
    ]
    d.polygon(body, fill=BLUE)
    # eyes + shine so it still reads as the mascot
    d.ellipse((10 * k, 10 * k, 17 * k, 17 * k), fill=WHITE)
    d.ellipse((12 * k, 12 * k, 15 * k, 15 * k), fill=INK)
    d.ellipse((20 * k, 20 * k, 24 * k, 24 * k), fill=BELLY)
    return img


def save(img, path, size=SIZE):
    out = img.resize((size, size), Image.LANCZOS)
    # soft outline so the sprite stays readable on light and dark backgrounds
    alpha = out.split()[3]
    edge = alpha.filter(ImageFilter.MaxFilter(3)).point(lambda v: 255 if v > 40 else 0)
    ring = Image.new("RGBA", out.size, (255, 255, 255, 0))
    ring.putalpha(edge)
    rim = Image.new("RGBA", out.size, (255, 255, 255, 255))
    rim.putalpha(edge.point(lambda v: int(v * 0.85)))
    composed = Image.alpha_composite(rim, out)
    composed.save(path)
    return path


def main():
    out_dir = os.environ.get("OUT_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    os.makedirs(out_dir, exist_ok=True)
    variants = {
        "cursor-kit-a.png": variant_classic(with_ears=True, tail_fin=True, blush=False),
        "cursor-kit-b.png": variant_classic(with_ears=True, tail_fin=True, blush=True),
        "cursor-kit-c.png": variant_classic(with_ears=False, tail_fin=True, blush=True),
        "cursor-kit-d.png": variant_minimal(),
    }
    made = []
    for name, img in variants.items():
        made.append(save(img, os.path.join(out_dir, name)))
    for path in made:
        print(path)


if __name__ == "__main__":
    main()