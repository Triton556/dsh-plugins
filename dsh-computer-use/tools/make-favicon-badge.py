# Build a favicon-sized badge: the DeepSeek whale cursor on a brand-blue roundel.
import base64
import os
from PIL import Image, ImageDraw

OUT = r"C:\Users\Danil\AppData\Local\Temp\favicon-badge.b64"
SPRITE = r"C:\Users\Danil\Documents\deepseek-harness\default-workspace\dsh-computer-use\tools\cursor-neon-crisp.png"

SIZE = 64
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.ellipse((1, 1, SIZE - 2, SIZE - 2), fill=(77, 107, 254, 255), outline=(255, 255, 255, 255), width=2)

whale = Image.open(SPRITE).convert("RGBA")
w = 40
whale = whale.resize((w, w), Image.LANCZOS)
img.alpha_composite(whale, ((SIZE - w) // 2, (SIZE - w) // 2))

img.save(r"C:\Users\Danil\AppData\Local\Temp\favicon-badge.png")
b64 = base64.b64encode(open(r"C:\Users\Danil\AppData\Local\Temp\favicon-badge.png", "rb").read()).decode()
open(OUT, "w").write(b64)
print("badge bytes:", len(b64))