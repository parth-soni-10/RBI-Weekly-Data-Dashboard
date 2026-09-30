# tools/make-icons.py — one-off generator for public/icons/*.png (PWA icons + maskable).
# Run from repo root: python tools/make-icons.py
from PIL import Image, ImageDraw, ImageFont

R2 = 11  # same radius language as .logo-badge

def build(px):
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Brand gradient (amber -> gold, 135deg) inside a rounded square, like the header badge.
    grad = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    top, bot = (246, 207, 126), (233, 153, 34)  # --brand2 -> --brand
    for y in range(px):
        t = y / max(1, px - 1)
        row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (px, y)], fill=row)
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1], radius=int(px * R2 / 34), fill=255)
    img.paste(grad, (0, 0), mask)
    # The rupee glyph, dark-on-gold like the badge.
    try:
        f = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", int(px * 0.62))
    except OSError:
        f = ImageFont.load_default()
    bbox = d.textbbox((0, 0), "\u20B9", font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((px - w) / 2 - bbox[0], (px - h) / 2 - bbox[1]), "\u20B9",
           font=f, fill=(36, 26, 4))  # --on-brand
    return img

OUT = {
    "icon-192.png": (192, False),
    "icon-512.png": (512, False),
    "maskable-192.png": (192, True),
    "maskable-512.png": (512, True),
}
import os
os.makedirs("public/icons", exist_ok=True)
for name, (px, maskable) in OUT.items():
    img = build(px)
    if maskable:
        # Safe zone: shrink content into the middle 80% so Android crop never clips it.
        inner = img.resize((int(px * 0.78), int(px * 0.78)), Image.LANCZOS)
        canvas = Image.new("RGBA", (px, px), (11, 17, 32, 255))  # #0b1120
        off = (px - inner.width) // 2
        canvas.paste(inner, (off, off), inner)
        img = canvas
    img.save(f"public/icons/{name}", optimize=True)
    print("wrote public/icons/" + name)
