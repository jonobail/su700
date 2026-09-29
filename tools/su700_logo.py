#!/usr/bin/env python3
"""SU700 display legend ("SAMPLING UNIT" + outlined SU / solid 700) as public/su700-logo.svg.

Geometry is measured off a straight-on photo of the unit (logo 14px tall there, 9.29 units per
photo pixel). Needs fontTools for the small lettering: pip install fonttools; python3 tools/su700_logo.py
"""
import math, pathlib
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

RED = '#c8312f'  # photo samples #a02e2c through the glass; brightened to the printed ink
H = 130  # logo cap height (units measured off a 9.6x zoom of the photo)

def rounded(pts, r):
    """Closed polygon path with every corner rounded (radius clamped to half the shorter edge)."""
    n = len(pts); d = ''
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        rr = r[i] if isinstance(r, list) else r
        def toward(a, b, dist):
            L = math.dist(a, b); dist = min(dist, L / 2)
            return (a[0] + (b[0] - a[0]) * dist / L, a[1] + (b[1] - a[1]) * dist / L)
        a = toward(p1, p0, rr); b = toward(p1, p2, rr)
        d += ('M' if i == 0 else 'L') + f'{a[0]:.1f},{a[1]:.1f}Q{p1[0]:.1f},{p1[1]:.1f} {b[0]:.1f},{b[1]:.1f}'
    return d + 'Z'

def shift(pts, dx):
    return [(x + dx, y) for x, y in pts]

# Measured off the photo at 9.29 units per photo pixel (logo is 14px tall there).
th, tv = 28, 33          # horizontal / vertical stroke weights
S_ = [(0,0),(204,0),(204,th),(tv,th),(tv,51),(204,51),(204,130),(0,130),(0,102),(204-tv,102),(204-tv,79),(0,79)]
S_r = [16,16,3,3,3,16,16,16,3,3,3,16]
U_ = [(0,0),(tv,0),(tv,102),(195-tv,102),(195-tv,0),(195,0),(195,130),(0,130)]
U_r = [3,3,6,6,3,3,18,18]
SEVEN = [(0,0),(195,0),(195,th),(84,130),(46,130),(139,th),(0,th)]
SEVEN_r = [4,8,4,3,3,3,3]
def zero(x):
    outer = rounded(shift([(0,0),(195,0),(195,130),(0,130)], x), 18)
    inner = rounded(shift([(tv,th),(195-tv,th),(195-tv,130-th),(tv,130-th)], x), 5)
    return outer + inner

sw = 6  # outline weight of the hollow S and U
logo = (f'<path d="{rounded(S_, S_r)}{rounded(shift(U_, 214), U_r)}" fill="none" stroke="{RED}" '
        f'stroke-width="{sw}" stroke-linejoin="round"/>\n'
        f'  <path d="{rounded(shift(SEVEN, 418), SEVEN_r)}{zero(622)}{zero(827)}" fill="{RED}" fill-rule="evenodd"/>')

# "SAMPLING UNIT": Liberation Sans Bold (Helvetica metrics) as outlines, cap height 58. Each letter's
# ink is fitted to the span it covers in the photo (photo x, from a per-column red profile), which
# carries the original's letter widths and spacing.
SPANS = [('S', 469.7, 474.3), ('A', 475.3, 479.8), ('M', 480.6, 486.6), ('P', 487.6, 491.6),
         ('L', 492.6, 496.3), ('I', 497.6, 498.8), ('N', 499.6, 504.6), ('G', 505.5, 510.8),
         ('U', 513.6, 518.7), ('N', 519.6, 524.6), ('I', 525.5, 526.8), ('T', 527.8, 532.4)]
PX = 9.29  # units per photo pixel; the S of SU700 starts at photo x 540
font = TTFont('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf')
gs = font.getGlyphSet(); cmap = font.getBestCmap(); cap = font['OS/2'].sCapHeight
k = 58 / cap
parts = []
for c, l, r in SPANS:
    g = gs[cmap[ord(c)]]
    bp = BoundsPen(gs); g.draw(bp)
    x0, _, x1, _ = bp.bounds
    ul, ur = (l - 540) * PX, (r - 540) * PX
    kx = (ur - ul) / (x1 - x0)
    pen = SVGPathPen(gs, ntos=lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
    g.draw(TransformPen(pen, (kx, 0, 0, -k, ul - x0 * kx, 130)))
    parts.append(pen.getCommands())
small = f'<path d="{"".join(parts)}" fill="{RED}"/>'

x0 = round((SPANS[0][1] - 540) * PX)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0 - 4} -4 {1022 - x0 + 8} 138">
  <!-- SU700 display legend, traced from a photo of the unit: SU hollow, 700 solid. -->
  {small}
  {logo}
</svg>
'''
(pathlib.Path(__file__).resolve().parent.parent / 'public' / 'su700-logo.svg').write_text(svg)
