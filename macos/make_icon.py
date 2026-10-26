"""Draws the app icon: a page with a highlighted line and a numbered margin pin.

Usage: python make_icon.py <out.iconset dir>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # macOS icon grid: 824px rounded square centred on a 1024 canvas
    m, r = 100, 185
    bg = Image.new("RGBA", (S, S))
    top, bot = (240, 138, 75), (194, 65, 12)
    px = bg.load()
    for y in range(S):
        c = lerp(top, bot, y / S)
        for x in range(S):
            px[x, y] = (*c, 255)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([m, m, S - m, S - m], r, fill=255)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([m, m + 14, S - m, S - m + 14], r, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # the page, with a folded corner
    x0, y0, x1, y1, fold = 290, 215, 734, 809, 96
    page_shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(page_shadow).rounded_rectangle([x0 + 6, y0 + 16, x1 + 6, y1 + 16], 26, fill=(80, 20, 0, 110))
    img.alpha_composite(page_shadow.filter(ImageFilter.GaussianBlur(16)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x0, y0, x1, y1], 26, fill=(255, 252, 247, 255))
    d.polygon([(x1 - fold, y0), (x1, y0), (x1, y0 + fold)], fill=(0, 0, 0, 0))
    img_page = img.copy()
    d = ImageDraw.Draw(img_page)
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(240, 214, 196, 255))
    img = img_page
    d = ImageDraw.Draw(img)
    # text lines; one highlighted
    lx0, lw, lh = x0 + 62, x1 - x0 - 124, 22
    ys = [330, 398, 466, 534, 602, 670, 738]
    widths = [0.72, 1.0, 0.92, 1.0, 0.86, 1.0, 0.6]
    for i, (y, w) in enumerate(zip(ys, widths)):
        if i == 3:
            d.rounded_rectangle([lx0 - 16, y - 20, lx0 + lw + 16, y + lh + 20], 14, fill=(250, 204, 21, 235))
        d.rounded_rectangle([lx0, y, lx0 + lw * w, y + lh], 11, fill=(120, 92, 70, 255) if i == 3 else (205, 190, 178, 255))
    # margin pin
    cx, cy, pr = x1 + 4, ys[3] + lh // 2, 62
    pin_shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(pin_shadow).ellipse([cx - pr + 4, cy - pr + 10, cx + pr + 4, cy + pr + 10], fill=(60, 15, 0, 120))
    img.alpha_composite(pin_shadow.filter(ImageFilter.GaussianBlur(10)))
    d = ImageDraw.Draw(img)
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=(255, 255, 255, 255))
    d.ellipse([cx - pr + 10, cy - pr + 10, cx + pr - 10, cy + pr - 10], fill=(194, 65, 12, 255))
    font = None
    for f in ("/System/Library/Fonts/SFNSRounded.ttf", "/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            font = ImageFont.truetype(f, 80)
            break
        except OSError:
            pass
    d.text((cx, cy - 4), "?", fill=(255, 255, 255, 255), font=font, anchor="mm")
    return img


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 128, 256, 512):
        big.resize((size, size), Image.LANCZOS).save(out / f"icon_{size}x{size}.png")
        big.resize((size * 2, size * 2), Image.LANCZOS).save(out / f"icon_{size}x{size}@2x.png")


if __name__ == "__main__":
    main()
