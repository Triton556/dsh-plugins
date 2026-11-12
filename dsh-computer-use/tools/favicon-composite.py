# Composite: the site's original favicon + the DeepSeek whale cursor on top.
# Usage: python favicon-composite.py <favicon_path> <out_b64_path>
import base64
import sys

from PIL import Image

FAV = sys.argv[1]
OUT = sys.argv[2]
SPRITE = r"C:\Users\Danil\Documents\deepseek-harness\default-workspace\dsh-computer-use\tools\cursor-neon-crisp.png"

SIZE = 64
canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

fav = Image.open(FAV)
# ICO: take the largest frame; any other format: fit to the canvas
try:
    fav.size = (64, 64)  # request the largest ICO frame
except Exception:
    pass
fav = fav.convert("RGBA")
# crop transparent margins so the icon keeps its original visual size
bbox = fav.getbbox()
if bbox and (bbox[2] - bbox[0] < fav.width * 0.9 or bbox[3] - bbox[1] < fav.height * 0.9):
    fav = fav.crop(bbox)
# fit by the larger side, centred: the icon fills the canvas like before
side = max(fav.width, fav.height)
scale = SIZE / side
nw, nh = max(1, round(fav.width * scale)), max(1, round(fav.height * scale))
fav = fav.resize((nw, nh), Image.LANCZOS)
canvas.alpha_composite(fav, ((SIZE - nw) // 2, (SIZE - nh) // 2))

# whale cursor over the WHOLE icon: same size as the favicon, transparency of the
# sprite lets the original show through around the body
whale = Image.open(SPRITE).convert("RGBA")
whale = whale.resize((SIZE, SIZE), Image.LANCZOS)
canvas.alpha_composite(whale, (0, 0))

canvas.save(OUT + ".png")
b64 = base64.b64encode(open(OUT + ".png", "rb").read()).decode()
open(OUT, "w").write(b64)
print("composite bytes:", len(b64))