# Turn a soft-alpha sprite into a colour-key-safe one.
#
# The overlay window uses a transparent colour key, so semi-transparent pixels blend
# with that key and turn magenta. Ordered dithering keeps the glow readable while
# every pixel is either fully opaque or fully transparent.
import os
from PIL import Image

BAYER = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]


def dither(src_path, dst_path, boost=1.0):
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    src = img.load()
    dst = out.load()
    for y in range(h):
        row = BAYER[y % 8]
        for x in range(w):
            r, g, b, a = src[x, y]
            if a >= 248:
                dst[x, y] = (r, g, b, 255)
                continue
            if a <= 6:
                continue
            threshold = (row[x % 8] + 0.5) / 64.0 * 255.0
            if a * boost > threshold:
                # keep the colour but push it towards the glow tone for readability
                dst[x, y] = (min(255, int(r * 1.0)), min(255, int(g * 1.02)), 255, 255)
    out.save(dst_path)
    opaque = sum(1 for p in out.getdata() if p[3] > 0)
    print(dst_path, out.size, "opaque px:", opaque)


def main():
    base = os.environ.get("SPRITE_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    src = os.path.join(base, "cursor-neon-crisp.png")
    dst = os.environ.get("OUT") or os.path.join(os.getcwd(), "cursor-neon-keyed.png")
    dither(src, dst)


if __name__ == "__main__":
    main()