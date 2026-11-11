# Classic Windows arrow (the familiar pointer shape) rendered at 4x, then tinted.
#
# Points follow the standard 11x19 arrow so it reads exactly like the system cursor,
# scaled up and given a crisp outline. Fill is white (default) or a DeepSeek tint.
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 6
SIZE = 40
W = SIZE * SS

# classic pointer polygon, 11x19 units
SHAPE = [
    (0, 0), (0, 16), (4, 12), (7, 19), (9, 18), (6, 11), (11, 11),
]


def render(fill, outline, size=SIZE):
    k = SS * (size / 19.0)
    img = Image.new("RGBA", (int(19 * k) + 8, int(19 * k) + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [(x * k + 2, y * k + 2) for (x, y) in SHAPE]
    d.polygon(pts, fill=fill, outline=outline, width=max(2, int(k * 1.1)))
    return img


def save(img, path, size):
    # downsample to the final size, keeping a soft edge
    out = img.resize((size, size), Image.LANCZOS)
    out.save(path)
    return path


def main():
    out_dir = os.environ.get("OUT_DIR") or os.path.join(os.getcwd(), "tools", "cua", "shots")
    os.makedirs(out_dir, exist_ok=True)
    variants = {
        "cursor-arrow-white.png": (255, 255, 255, 255),
        "cursor-arrow-tint.png": (196, 212, 255, 255),
        "cursor-arrow-blue.png": (150, 174, 255, 255),
    }
    for name, fill in variants.items():
        img = render(fill, (18, 22, 40, 255))
        for size in (40, 64):
            path = os.path.join(out_dir, name.replace(".png", f"-{size}.png"))
            save(img, path, size)
            print(path)


if __name__ == "__main__":
    main()