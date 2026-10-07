#!/usr/bin/env python3
"""Render public/icons/*.png — the PWA tile and its two maskable variants.

    python tools/make-icons.py

Why rasters exist at all: the manifest declares a 192 and a 512 for an install
prompt and `purpose: "maskable"` entries for Android, and none of those can be
an SVG. Run this after a brand change so the PNGs and the stylesheet keep one
palette (--brand / --brand2 / --on-brand in public/styles.css).

The design is the header badge: the amber-to-gold gradient inside a rounded
square, with the rupee mark knocked out of it in --on-brand. Dark-on-gold is
deliberate and is what makes the tile readable on dark browser chrome — the
*gold plate* carries the shape against a dark toolbar, and the near-black glyph
carries it against a light one, so no prefers-color-scheme variant is needed.

Two previous defects are worth naming, because both were invisible in a
screenshot of the page and only show up as an icon:

  * the gradient was drawn onto the tile and then the *empty* gradient image was
    pasted through the rounded-rectangle mask, which punched the middle out to
    transparent — 88% of the interior. What shipped was four gold corners and a
    dark glyph floating in a hole.
  * a missing font silently fell back to Pillow's bitmap default. A rupee sign
    is not in that font, so the glyph would have been a tofu box on a machine
    without the listed face. It now fails loudly instead.

Needs Pillow (`pip install pillow`) and one bold system sans for the glyph.
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "public", "icons")

# Brand ramp, matching --brand and --brand2 in public/styles.css.
BRAND = (233, 153, 34)
BRAND2 = (246, 207, 126)
ON_BRAND = (36, 26, 4)          # --on-brand
CANVAS = (11, 17, 32)           # theme_color, behind a maskable icon
MARK = "\u20b9"

# Same radius language as .logo-badge. The badge is 34 units wide with an 11-unit
# radius, so the ratio survives any output size.
BADGE_UNITS = 34
BADGE_RADIUS = 11
MARK_SCALE = 0.62               # glyph size, as a fraction of the tile
SAFE_ZONE = 0.78                # maskable content inset, inside Android's crop

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
]


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    sys.exit(
        "No bold system sans found. Add its path to FONT_CANDIDATES in "
        "tools/make-icons.py, then re-run. Refusing to fall back to Pillow's "
        "bitmap default: it has no rupee sign, so the mark would be a tofu box."
    )


def diagonal_gradient(size: int) -> Image.Image:
    """--brand2 -> --brand along the 135deg axis, i.e. top-left to bottom-right."""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    span = max(1, 2 * (size - 1))
    for y in range(size):
        for x in range(size):
            t = (x + y) / span
            px[x, y] = (
                round(BRAND2[0] + (BRAND[0] - BRAND2[0]) * t),
                round(BRAND2[1] + (BRAND[1] - BRAND2[1]) * t),
                round(BRAND2[2] + (BRAND[2] - BRAND2[2]) * t),
                255,
            )
    return img


def badge(size: int) -> Image.Image:
    """The gradient tile with the glyph knocked into it, supersampled 4x."""
    scale = 4
    px = size * scale
    tile = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, px - 1, px - 1], radius=round(px * BADGE_RADIUS / BADGE_UNITS), fill=255
    )
    tile.paste(diagonal_gradient(px), (0, 0), mask)

    font = ImageFont.truetype(find_font(), round(px * MARK_SCALE))
    draw = ImageDraw.Draw(tile)
    left, top, right, bottom = draw.textbbox((0, 0), MARK, font=font)
    draw.text(
        ((px - (right - left)) / 2 - left, (px - (bottom - top)) / 2 - top),
        MARK,
        font=font,
        fill=ON_BRAND,
    )
    return tile.resize((size, size), Image.LANCZOS)


def maskable(tile: Image.Image, size: int) -> Image.Image:
    """The badge inset on the theme colour: Android crops to a circle or squircle,
    so anything outside the middle ~80% can be cut off."""
    canvas = Image.new("RGBA", (size, size), CANVAS + (255,))
    inner = tile.resize((round(size * SAFE_ZONE), round(size * SAFE_ZONE)), Image.LANCZOS)
    offset = (size - inner.width) // 2
    canvas.paste(inner, (offset, offset), inner)
    return canvas


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    for name, size, is_maskable in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("maskable-192.png", 192, True),
        ("maskable-512.png", 512, True),
    ):
        tile = badge(size)
        out = maskable(tile, size) if is_maskable else tile
        path = os.path.join(ICONS, name)
        out.save(path, "PNG", optimize=True)
        print(f"wrote public/icons/{name} ({size}x{size}, {os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
