# Generates build/icon.png (1024px) and build/icon.icns for Pi Desktop on macOS.
# Design: Big Sur-style squircle in Claude's coral (#E8714E → #EC5F38), white serif "π" (New York, heavy).
# Run with any Python that has Pillow:  python3 build/make-icon.py
import math, os, subprocess
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

S, BODY = 1024, 824
here = os.path.dirname(os.path.abspath(__file__))

def squircle_mask(n=5.0, scale=4):
    big = S * scale
    mask = Image.new('L', (big, big), 0)
    c, a = big / 2, BODY * scale / 2
    pts = []
    for i in range(1440):
        t = 2 * math.pi * i / 1440
        x, y = math.cos(t), math.sin(t)
        pts.append((c + a * abs(x) ** (2 / n) * (1 if x >= 0 else -1), c + a * abs(y) ** (2 / n) * (1 if y >= 0 else -1)))
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask.resize((S, S), Image.LANCZOS)

def gradient(c1, c2, angle=90):
    ramp = Image.new('RGB', (1, 256))
    for i in range(256):
        t = i / 255
        ramp.putpixel((0, i), tuple(int(c1[k] + (c2[k] - c1[k]) * t) for k in range(3)))
    g = ramp.resize((S * 2, S * 2)).rotate(90 - angle, resample=Image.BICUBIC)
    return g.crop((S // 2, S // 2, S // 2 + S, S // 2 + S))

def variable_font(path, size, **wanted):
    font = ImageFont.truetype(path, size)
    try:
        values = []
        for axis in font.get_variation_axes():
            name = axis['name'].decode() if isinstance(axis['name'], bytes) else axis['name']
            values.append(wanted.get(name.lower(), axis.get('default', axis['minimum'])))
        font.set_variation_by_axes(values)
    except Exception:
        pass
    return font

def glyph_mask(text, font, center):
    mask = Image.new('L', (S, S), 0)
    draw = ImageDraw.Draw(mask)
    box = draw.textbbox((0, 0), text, font=font, anchor='ls')
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text((center[0] - w / 2 - box[0], center[1] + h / 2 - box[3]), text, font=font, fill=255, anchor='ls')
    return mask

mask = squircle_mask()
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# drop shadow under the tile
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow.paste((0, 0, 0, 255), (0, 18), mask.point(lambda v: v * 0.55))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(22)))

# tile: Claude's coral, top to bottom
img.paste(gradient((232, 113, 78), (236, 95, 56), angle=90).convert('RGBA'), (0, 0), mask)

# inner rim highlight, strongest at the top
ring = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(7)))
ring = ImageChops.multiply(ring, gradient((255, 255, 255), (0, 0, 0)).convert('L').point(lambda v: int(v * 110 / 255)))
img.paste((255, 214, 196, 255), (0, 0), ring)

# white π with a light warm shadow
serif = variable_font('/System/Library/Fonts/NewYork.ttf', 600, weight=860, **{'optical size': 72})
pi = glyph_mask('π', serif, (512, 500))
glyph_shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
glyph_shadow.paste((150, 45, 15, 255), (0, 10), pi.point(lambda v: v * 70 // 255))
img = Image.alpha_composite(img, glyph_shadow.filter(ImageFilter.GaussianBlur(14)))
img.paste((255, 255, 255, 255), (0, 0), pi)

img.save(os.path.join(here, 'icon.png'))
iconset = os.path.join(here, 'icon.iconset')
os.makedirs(iconset, exist_ok=True)
for size in [16, 32, 128, 256, 512]:
    img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
    img.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(here, 'icon.icns')], check=True)
for name in os.listdir(iconset):
    os.remove(os.path.join(iconset, name))
os.rmdir(iconset)
print('wrote build/icon.png and build/icon.icns')
