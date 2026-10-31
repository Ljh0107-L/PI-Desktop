# Generates build/icon.png (1024px), build/icon.icns and the in-app copy from build/icon-source.png.
# The source art is a full-bleed 1024px tile; this recentres its π (bounding box at the optical centre,
# slightly above the middle), rebuilds the tile background as a smooth gradient fitted to the art, and
# places it on the macOS Big Sur grid: an 824px squircle with a soft drop shadow inside a 1024px canvas.
# Run with any Python that has Pillow and NumPy:  python3 build/make-icon.py
import math, os, subprocess
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S, BODY = 1024, 824
here = os.path.dirname(os.path.abspath(__file__))
src = Image.open(os.path.join(here, 'icon-source.png')).convert('RGB').resize((S, S), Image.LANCZOS)
a = np.asarray(src).astype(float)

# the white glyph, and everything near it (its own soft shadow)
r, g, b = a[..., 0], a[..., 1], a[..., 2]
glyph = ((r > 225) & (g > 215) & (b > 200)).astype(np.uint8) * 255
near = np.asarray(Image.fromarray(glyph).filter(ImageFilter.MaxFilter(91))) > 0

# background: a smooth cubic surface fitted to the tile away from the glyph and the source's rim
yy, xx = np.mgrid[0:S, 0:S]
def features(x, y):
    x, y = (x - S / 2) / (S / 2), (y - S / 2) / (S / 2)
    return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y, x ** 3, x * x * y, x * y * y, y ** 3], -1)
sample = (xx > 60) & (xx < S - 60) & (yy > 60) & (yy < S - 60) & ~near
background = np.zeros_like(a)
for c in range(3):
    coef, *_ = np.linalg.lstsq(features(xx[sample], yy[sample]), a[..., c][sample], rcond=None)
    background[..., c] = features(xx, yy) @ coef

# move the glyph (with its shadow) so its bounding box is centred, a touch above the middle
ys, xs = np.where(glyph > 0)
dx, dy = S / 2 - (xs.min() + xs.max()) / 2, S / 2 - 4 - (ys.min() + ys.max()) / 2
shift = (1, 0, -dx, 0, 1, -dy)
feather = Image.fromarray((near * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(14))
content = Image.fromarray(np.clip(background, 0, 255).astype(np.uint8))
content.paste(src.transform(src.size, Image.AFFINE, shift, resample=Image.BICUBIC), (0, 0), feather.transform(src.size, Image.AFFINE, shift, resample=Image.BICUBIC))

def squircle_mask(n=5.0, scale=4):
    big = S * scale
    mask = Image.new('L', (big, big), 0)
    c, half = big / 2, BODY * scale / 2
    pts = []
    for i in range(1440):
        t = 2 * math.pi * i / 1440
        x, y = math.cos(t), math.sin(t)
        pts.append((c + half * abs(x) ** (2 / n) * (1 if x >= 0 else -1), c + half * abs(y) ** (2 / n) * (1 if y >= 0 else -1)))
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask.resize((S, S), Image.LANCZOS)

mask = squircle_mask()
tile = Image.new('RGB', (S, S))
tile.paste(content.resize((BODY, BODY), Image.LANCZOS), ((S - BODY) // 2, (S - BODY) // 2))

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
shadow.paste((0, 0, 0, 255), (0, 14), mask.point(lambda v: v * 0.45))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(20)))
img.paste(tile.convert('RGBA'), (0, 0), mask)
# hairline highlight along the top edge
ring = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))
fade = Image.linear_gradient('L').rotate(180).resize((S, S)).point(lambda v: v * 90 // 255)
img.paste((255, 226, 208, 255), (0, 0), ImageChops.multiply(ring, fade))

img.save(os.path.join(here, 'icon.png'))
img.resize((256, 256), Image.LANCZOS).save(os.path.join(here, '..', 'app', 'renderer', 'public', 'app-icon.png'))
iconset = os.path.join(here, 'icon.iconset')
os.makedirs(iconset, exist_ok=True)
for size in [16, 32, 128, 256, 512]:
    img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
    img.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(here, 'icon.icns')], check=True)
for name in os.listdir(iconset):
    os.remove(os.path.join(iconset, name))
os.rmdir(iconset)
print('wrote build/icon.png, build/icon.icns and app/renderer/public/app-icon.png')
