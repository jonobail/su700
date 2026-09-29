#!/usr/bin/env python3
"""Pixel-art SU700 favicon.

Draws the panel onto a 32x32 grid (positions and colours measured from a photo of
the real unit) and writes
public/favicon.svg, public/favicon.ico (16 hand-drawn, 32, 64) and public/apple-touch-icon.png.
No dependencies: python3 tools/favicon.py
"""
import pathlib, struct, sys, zlib

C = {
    'body': '#3e546d', 'front': '#1c3b59', 'shade': '#0e2b43', 'slot': '#0a1c2b',
    'silk': '#dfe3e7', 'box': '#ccd3d7', 'print': '#566b80', 'line': '#91a0ae', 'label': '#aeb8c2',
    'key': '#262d35', 'gray': '#9ba7b1', 'cream': '#ede4de', 'cream_edge': '#b8b0aa',
    'led': '#e0322c', 'disp': '#141b1f', 'unlit': '#2c3a3c', 'vfd': '#6fd6c8', 'logo': '#d8403a',
    'm_or': '#e7ae2d', 'm_wh': '#e0ebeb', 'm_bl': '#6697c1', 'm_rd': '#e2524e',
    'k_or': '#e3924f', 'k_cr': '#dfe3e6', 'k_bl': '#93a2c9', 'k_rd': '#d85466',
    'p_or': '#e8944d', 'p_gr': '#b7c0cb', 'p_bl': '#6787b6', 'p_rd': '#de5f6d',
    'p_or_dk': '#c97a3a', 'p_gr_dk': '#98a2ae', 'p_bl_dk': '#546f98', 'p_rd_dk': '#c24a59',
    'ribbon': '#4a6b88',
}

W = H = 32
px = [[None] * W for _ in range(H)]

def put(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = C[c]

def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(x, y, c)

# ---- chassis: blue top surface rows 2-21, darker navy front rows 22-29 ----
rect(0, 2, 31, 21, 'body')
rect(0, 22, 31, 29, 'front')
rect(0, 22, 31, 22, 'shade')
for x, y in [(0, 2), (31, 2), (0, 29), (31, 29)]:
    px[y][x] = None

# ---- knob function column: white tabs + key columns (third column only where the panel has one) ----
for y0, y1 in [(3, 5), (7, 7), (9, 10), (12, 13), (15, 15), (17, 19)]:
    rect(1, y0, 2, y1, 'box')
for y, n in {4: 3, 6: 3, 8: 2, 10: 2, 12: 2, 14: 3, 16: 3, 18: 2}.items():
    for i in range(n):
        put(4 + 2 * i, y, 'gray' if y >= 16 else 'key')
for x, y in [(1, 20), (1, 21), (3, 21)]:
    put(x, y, 'label')                                   # dotted line to the knobs

# ---- mode keys with white labels, function grid with gray pills ----
cols = range(11, 22, 2)
for x in cols:
    put(x, 3, 'box')
    put(x, 4, 'key')
for y in (6, 8):
    rect(9, y, 10, y, 'gray')
    for x in cols:
        put(x, y, 'print')

# ---- scene row: labels, INIT + scene keys ----
for x in cols:
    put(x, 10, 'box')
    put(x, 11, 'key')
rect(9, 11, 10, 11, 'gray')

# ---- transport: record, 5 cream keys, undo pill ----
rect(9, 13, 10, 14, 'cream'); put(10, 13, 'led')
rect(12, 13, 19, 14, 'cream')
for x in (13, 15, 17, 19):
    put(x, 14, 'cream_edge')
rect(21, 13, 22, 14, 'gray')

# ---- display: SU700 logo, counter, 12 track meters ----
rect(9, 15, 22, 19, 'disp')
for x in range(10, 18):
    put(x, 16, 'unlit')                                  # unlit 14-segment characters
rect(19, 15, 21, 15, 'logo')                             # SU700
rect(19, 16, 21, 16, 'vfd')                              # 001:1
meters = ['m_or', 'm_or', 'm_wh', 'm_wh', 'm_wh', 'm_wh', 'm_bl', 'm_bl', 'm_bl', 'm_bl', 'm_or', 'm_rd']
tall = [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1]
for i, (c, t) in enumerate(zip(meters, tall)):
    x = 10 + i
    put(x, 17, c if t else 'unlit')
    put(x, 18, c)

# ---- right side: YAMAHA, sampling box, jog, measure/bpm/note, ribbon ----
put(25, 2, 'silk'); rect(27, 2, 30, 2, 'silk')           # emblem + wordmark
rect(23, 4, 27, 7, 'line'); rect(24, 5, 26, 6, 'body')   # sampling box outline
rect(24, 5, 25, 6, 'cream'); put(26, 5, 'key')           # START/STOP key, level knob
put(29, 5, 'key')                                        # master volume
put(24, 8, 'key'); put(26, 8, 'key')                     # < > keys
put(29, 10, 'key')                                       # bpm counter
rect(23, 9, 27, 13, 'key')                               # jog wheel
for x, y in [(23, 9), (27, 9), (23, 13), (27, 13)]:
    put(x, y, 'body')
put(24, 15, 'key'); put(26, 15, 'key')                   # cancel / ok
for y in (17, 19):
    put(24, y, 'key')                                    # measure / bpm / note
rect(28, 11, 30, 19, 'ribbon'); rect(29, 12, 29, 18, 'key')

# ---- knob row, with the fader slots running down into the front ----
knobs = ['k_or', 'k_or', 'k_cr', 'k_cr', 'k_cr', 'k_cr', 'k_bl', 'k_bl', 'k_bl', 'k_bl', 'k_or', 'k_rd']
for i, c in enumerate(knobs):
    put(5 + 2 * i, 21, c)
    put(5 + 2 * i, 23, 'slot')
put(29, 21, 'key')                                       # ribbon track

# ---- front: track bank, 12 pads, pad function, white group labels ----
for y, c in zip(range(24, 28), ['p_gr', 'p_bl', 'p_or', 'p_rd']):
    rect(1, y, 2, y, c)
    rect(29, y, 30, y, c)
pads = ['p_or', 'p_or', 'p_gr', 'p_gr', 'p_gr', 'p_gr', 'p_bl', 'p_bl', 'p_bl', 'p_bl', 'p_or', 'p_rd']
for i, c in enumerate(pads):
    # 2px pads with no gap; alternate pads use a darker tone so neighbours stay distinct
    rect(4 + 2 * i, 24 if 2 <= i <= 9 else 25, 5 + 2 * i, 26, c + '_dk' if i % 2 else c)
for x0, x1 in [(4, 6), (8, 14), (16, 22), (24, 24), (26, 26)]:
    rect(x0, 27, x1, 27, 'label')

# ---- 16x16: hand-simplified, since halving the 32 grid turns to mush ----
SMALL = """
................
.BBBBBBBBBBBBBB.
BWBKBWBWBWBBWWWB
BWBBBKBKBKBBBBBB
BWBKBBBBBBBBCCKB
BBBKBRBCCCBGBBBB
BWBBBBBBBBBBKKBB
BWBGBDDDDDDBKKBK
BWBGBDDDDRqBBBBK
BBBBBoowwuuBKBBK
BBOBEBEBVBVBXBBB
aaaaaaaaaaaaaaaa
FFFFFFFFFFFFFFFF
FFPPggggppppPrFF
FFPPggggppppPrFF
.FFFFFFFFFFFFFF.
"""
SMALL_PAL = {'B': 'body', 'W': 'box', 'K': 'key', 'G': 'gray', 'C': 'cream', 'L': 'line',
             'R': 'led', 'D': 'disp', 'q': 'vfd', 'o': 'm_or', 'w': 'm_wh', 'u': 'm_bl',
             'O': 'k_or', 'E': 'k_cr', 'V': 'k_bl', 'X': 'k_rd', 'a': 'shade', 'F': 'front',
             'P': 'p_or', 'g': 'p_gr', 'p': 'p_bl', 'r': 'p_rd'}
small = [[C[SMALL_PAL[ch]] if ch != '.' else None for ch in line]
         for line in SMALL.strip().splitlines()]
assert len(small) == 16 and all(len(r) == 16 for r in small)

# ---------------------------------------------------------------- output
def rgba(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,)

def scaled(n, grid=px):
    """Nearest-neighbour resample of a grid to n x n."""
    g = len(grid)
    return [[grid[y * g // n][x * g // n] for x in range(n)] for y in range(n)]

def png(rows, bg=None):
    raw = b''
    for row in rows:
        raw += b'\0' + b''.join(bytes(rgba(c) if c else (rgba(bg) if bg else (0, 0, 0, 0))) for c in row)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    n = len(rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def ico(images):
    head = struct.pack('<HHH', 0, 1, len(images))
    off = 6 + 16 * len(images)
    dirs, data = b'', b''
    for n, blob in images:
        dirs += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(blob), off + len(data))
        data += blob
    return head + dirs + data

def svg():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">',
           '  <!-- Pixel-art SU700, generated by tools/favicon.py -->']
    for y, row in enumerate(px):
        x = 0
        while x < W:
            c = row[x]
            run = 1
            while x + run < W and row[x + run] == c:
                run += 1
            if c:
                out.append(f'  <rect x="{x}" y="{y}" width="{run}" height="1" fill="{c}"/>')
            x += run
    out.append('</svg>')
    return '\n'.join(out) + '\n'

pub = pathlib.Path(__file__).resolve().parent.parent / 'public'
if '--preview' in sys.argv:  # 12x zoom, for eyeballing edits
    pathlib.Path(sys.argv[-1]).write_bytes(png(scaled(384, small if '--small' in sys.argv else px)))
    sys.exit()
(pub / 'favicon.svg').write_text(svg())
(pub / 'favicon.ico').write_bytes(ico([(16, png(small))] + [(n, png(scaled(n))) for n in (32, 64)]))
touch = [[C['body'] if c is None else c for c in row] for row in scaled(160)]
pad = [C['body']] * 10
touch = [pad + r + pad for r in touch]
(pub / 'apple-touch-icon.png').write_bytes(png([[C['body']] * 180] * 10 + touch + [[C['body']] * 180] * 10))
