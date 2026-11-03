"""Build Bishop's icons from Kenney's chess_bishop.svg (Board Game Icons, CC0).

Usage: python scripts/gen-app-icon.py "D:/Game Tools and Assets/kenney/Icons/Board Game Icons"

Writes:
  src/assets/chess_bishop.svg                    original vector (unmodified)
  src/assets/LICENSE-kenney-board-game-icons.txt Kenney's CC0 license
  public/bishop.svg                              orange favicon
  public/favicon.ico                             16/32/48 px fallback favicon
  desktop-host/app.ico                           exe/window/taskbar icon, 16-256 px

The SVG is a single path made of M/L/Q commands, so it is rasterized here with
Pillow (no SVG renderer needed).
"""
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ORANGE = (249, 115, 22, 255)  # --primary-hover
TILE = (27, 26, 25, 255)  # --sidebar (dark)

pack = Path(sys.argv[1])
repo = Path(__file__).resolve().parent.parent
src_svg = pack / 'Vector' / 'Icons' / 'chess_bishop.svg'
svg = src_svg.read_text(encoding='utf-8')
path_d = re.search(r'\sd="([^"]+)"', svg).group(1)


def parse_path(d: str):
    """Return a list of polygons (lists of (x, y)) for M/L/Q path data."""
    tokens = re.findall(r'[MLQZmlqz]|-?\d*\.?\d+', d)
    polys, cur, cmd, i = [], [], None, 0
    pos = (0.0, 0.0)
    while i < len(tokens):
        t = tokens[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in 'Zz':
                if cur:
                    polys.append(cur)
                cur = []
            continue
        if cmd == 'M':
            if cur:
                polys.append(cur)
            pos = (float(tokens[i]), float(tokens[i + 1]))
            cur = [pos]
            i += 2
            cmd = 'L'  # implicit lineto after moveto
        elif cmd == 'L':
            pos = (float(tokens[i]), float(tokens[i + 1]))
            cur.append(pos)
            i += 2
        elif cmd == 'Q':
            cx, cy = float(tokens[i]), float(tokens[i + 1])
            ex, ey = float(tokens[i + 2]), float(tokens[i + 3])
            sx, sy = pos
            for k in range(1, 17):
                u = k / 16
                cur.append(((1 - u) ** 2 * sx + 2 * (1 - u) * u * cx + u * u * ex,
                            (1 - u) ** 2 * sy + 2 * (1 - u) * u * cy + u * u * ey))
            pos = (ex, ey)
            i += 4
        else:
            raise ValueError(f'unsupported path command {cmd}')
    if cur:
        polys.append(cur)
    return polys


polys = parse_path(path_d)
xs = [x for p in polys for x, _ in p]
ys = [y for p in polys for _, y in p]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
extent = max(maxx - minx, maxy - miny)


def render(size: int, tile: bool, fill_ratio: float) -> Image.Image:
    ss = 8  # supersampling factor
    big = size * ss
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if tile:
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.2), fill=TILE)
    scale = big * fill_ratio / extent
    for p in polys:
        draw.polygon([((x - cx) * scale + big / 2, (y - cy) * scale + big / 2) for x, y in p], fill=ORANGE)
    return img.resize((size, size), Image.LANCZOS)


assets = repo / 'src' / 'assets'
public = repo / 'public'
assets.mkdir(parents=True, exist_ok=True)
public.mkdir(parents=True, exist_ok=True)

shutil.copyfile(src_svg, assets / 'chess_bishop.svg')
shutil.copyfile(pack / 'License.txt', assets / 'LICENSE-kenney-board-game-icons.txt')

# Orange SVG favicon with a proper viewBox (the original has none).
pad = 4
vb = f'{minx - pad:g} {miny - pad:g} {maxx - minx + 2 * pad:g} {maxy - miny + 2 * pad:g}'
(public / 'bishop.svg').write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><path fill="#f97316" d="{path_d}"/></svg>\n',
    encoding='utf-8',
)

# App icon: orange bishop on a dark rounded tile. Small sizes use a larger glyph.
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [render(s, tile=True, fill_ratio=0.86 if s <= 24 else 0.78) for s in sizes]
frames[-1].save(repo / 'desktop-host' / 'app.ico', sizes=[(s, s) for s in sizes], append_images=frames[:-1])

fav = [render(s, tile=False, fill_ratio=0.95) for s in (16, 32, 48)]
fav[-1].save(public / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)], append_images=fav[:-1])
render(256, tile=True, fill_ratio=0.78).save(repo / 'docs' / 'app-icon-256.png')
print('viewBox', vb, '| polygons', len(polys))
