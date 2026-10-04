#!/usr/bin/env python3
"""Генерує іконки розширення без залежностей (лише стандартна бібліотека Python):

- icon.png            — іконка розширення в списку Extensions (256×256, кольорова);
- media/forgejo.ttf   — шрифт з одним гліфом U+E001 для `contributes.icons` («forgejo-logo»): $(forgejo-logo)
                        на кнопці «Publish to Forgejo» і в списку Git: Clone (одноколірна, як codicons).

Геометрія — логотип Forgejo (https://codeberg.org/forgejo/meta/src/branch/readme/branding, CC BY-SA 4.0,
автор Caesar Schinas): у SVG 212×212 дві «труби» товщиною 25 і три кільця r=18 товщиною 15, зсув translate(6,6).
Використання: python3 tools/make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ORANGE = (0xFF, 0x66, 0x00)
RED = (0xD4, 0x00, 0x00)
ARC_STEPS = 48
CIRCLE_STEPS = 96


# --- Геометрія логотипа (координати SVG: y донизу) ---

def arc(cx, cy, r, a0, a1, steps):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / steps), cy + r * math.sin(a0 + (a1 - a0) * i / steps))
            for i in range(steps + 1)]


def pipe(y_top):
    """Обведення штриха «M58 168 V{y_top} a50 50 0 0 1 50-50 h20» товщиною 25 (кінці — butt)."""
    w = 12.5
    outer = [(58 - w, 168)] + arc(108, y_top, 50 + w, math.pi, 1.5 * math.pi, ARC_STEPS) + [(128, y_top - 50 - w)]
    inner = [(128, y_top - 50 + w)] + arc(108, y_top, 50 - w, 1.5 * math.pi, math.pi, ARC_STEPS) + [(58 + w, 168)]
    return [outer + inner]


def ring(cx, cy):
    """Коло r=18 зі штрихом 15: зовнішній контур і отвір у протилежному напрямку."""
    outer = arc(cx, cy, 18 + 7.5, 0, 2 * math.pi, CIRCLE_STEPS)[:-1]
    hole = arc(cx, cy, 18 - 7.5, 2 * math.pi, 0, CIRCLE_STEPS)[:-1]
    return [outer, hole]


def logo():
    """Фігури в порядку малювання SVG: (колір, контури) зі зсувом translate(6,6)."""
    shapes = [
        (ORANGE, pipe(70)),
        (RED, pipe(138)),
        (ORANGE, ring(142, 20)),
        (RED, ring(142, 88)),
        (RED, ring(58, 180)),
    ]
    return [(color, [[(x + 6, y + 6) for x, y in c] for c in contours]) for color, contours in shapes]


def bbox(shapes):
    pts = [p for _, contours in shapes for c in contours for p in c]
    return (min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts))


def fit(shapes, size, height_ratio, flip_y=False, y_offset=0.0):
    """Масштабує логотип до height_ratio * size, по центру квадрата size×size."""
    x0, y0, x1, y1 = bbox(shapes)
    k = size * height_ratio / (y1 - y0)
    dx = (size - (x1 - x0) * k) / 2 - x0 * k
    dy = (size - (y1 - y0) * k) / 2 - y0 * k + y_offset

    def tr(x, y):
        nx, ny = x * k + dx, y * k + dy
        return (nx, size - ny) if flip_y else (nx, ny)
    return [(color, [[tr(x, y) for x, y in c] for c in contours]) for color, contours in shapes]


# --- Растеризація (ненульове правило заповнення, згладжування) ---

def coverage(contours, size, sub=8):
    """Покриття 0..1 для кожного пікселя: рядки — sub відліків на піксель, по x — точна частка відрізка."""
    cov = [[0.0] * size for _ in range(size)]
    edges = []
    for c in contours:
        for (xa, ya), (xb, yb) in zip(c, c[1:] + c[:1]):
            if ya != yb:
                edges.append((xa, ya, xb, yb, 1 if yb > ya else -1))
    for py in range(size):
        row = cov[py]
        for s in range(sub):
            y = py + (s + 0.5) / sub
            hits = []
            for xa, ya, xb, yb, d in edges:
                if (ya <= y < yb) or (yb <= y < ya):
                    hits.append((xa + (y - ya) * (xb - xa) / (yb - ya), d))
            hits.sort()
            wind = 0
            for i, (x, d) in enumerate(hits):
                prev = wind
                wind += d
                if prev == 0 and wind != 0:
                    start = x
                elif prev != 0 and wind == 0:
                    add_span(row, max(start, 0.0), min(x, float(size)), 1.0 / sub)
    return cov


def add_span(row, xa, xb, weight):
    if xb <= xa:
        return
    ia, ib = int(xa), int(xb)
    if ia == ib:
        row[ia] += (xb - xa) * weight
        return
    row[ia] += (ia + 1 - xa) * weight
    for i in range(ia + 1, min(ib, len(row))):
        row[i] += weight
    if ib < len(row):
        row[ib] += (xb - ib) * weight


def write_png(path, pixels, size):
    raw = b''.join(b'\x00' + bytes(v for px in pixels[y] for v in px) for y in range(size))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    path.write_bytes(png)


def make_png(path, size=256):
    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]
    for color, contours in fit(logo(), size, 0.86):
        cov = coverage(contours, size)
        for y in range(size):
            for x in range(size):
                a = min(cov[y][x], 1.0)
                if a <= 0:
                    continue
                r0, g0, b0, a0 = (v / 255 for v in pixels[y][x])
                ao = a + a0 * (1 - a)
                mix = lambda c, c0: (c / 255 * a + c0 * a0 * (1 - a)) / ao
                pixels[y][x] = (round(mix(color[0], r0) * 255), round(mix(color[1], g0) * 255),
                                round(mix(color[2], b0) * 255), round(ao * 255))
    write_png(path, pixels, size)


# --- Шрифт TrueType з одним гліфом ---

EM = 1000
CODEPOINT = 0xE001


def checksum(data):
    data += b'\0' * (-len(data) % 4)
    return sum(struct.unpack(f'>{len(data) // 4}I', data)) & 0xFFFFFFFF


def glyph_data(contours):
    pts = [(round(x), round(y)) for c in contours for x, y in c]
    ends, n = [], 0
    for c in contours:
        n += len(c)
        ends.append(n - 1)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    head = struct.pack('>hhhhh', len(contours), min(xs), min(ys), max(xs), max(ys))
    head += struct.pack(f'>{len(ends)}H', *ends) + struct.pack('>H', 0)
    flags = b'\x01' * len(pts)                      # усі точки на кривій, координати — int16-різниці
    dx = [xs[0]] + [xs[i] - xs[i - 1] for i in range(1, len(xs))]
    dy = [ys[0]] + [ys[i] - ys[i - 1] for i in range(1, len(ys))]
    data = head + flags + struct.pack(f'>{len(dx)}h', *dx) + struct.pack(f'>{len(dy)}h', *dy)
    return data + b'\0' * (-len(data) % 4), (min(xs), min(ys), max(xs), max(ys)), len(pts)


def name_table(names):
    records, strings = [], b''
    for name_id, text in names:
        s = text.encode('utf-16-be')
        records.append(struct.pack('>HHHHHH', 3, 1, 0x409, name_id, len(s), len(strings)))
        strings += s
    return struct.pack('>HHH', 0, len(records), 6 + 12 * len(records)) + b''.join(records) + strings


def cmap_table():
    # Формат 4 (Windows Unicode BMP): сегменти [E001] → гліф 1 і обов'язковий завершальний [FFFF]
    seg_x2, search_range, entry_selector = 4, 4, 1
    body = struct.pack('>HHHH', seg_x2, search_range, entry_selector, seg_x2 - search_range)
    body += struct.pack('>HHH', CODEPOINT, 0xFFFF, 0)                 # endCode[], reservedPad
    body += struct.pack('>HH', CODEPOINT, 0xFFFF)                     # startCode[]
    body += struct.pack('>HH', (1 - CODEPOINT) & 0xFFFF, 1)           # idDelta[]: E001 → 1, FFFF → 0
    body += struct.pack('>HH', 0, 0)                                  # idRangeOffset[]
    sub = struct.pack('>HHH', 4, 6 + len(body), 0) + body
    return struct.pack('>HH', 0, 1) + struct.pack('>HHI', 3, 1, 12) + sub


def make_font(path):
    shapes = fit(logo(), EM, 0.94, flip_y=True)
    # TrueType: зовнішні контури — за годинниковою стрілкою (y догори); віддзеркалення по y обернуло напрямок
    contours = [c[::-1] for _, cs in shapes for c in cs]
    glyf1, (xmin, ymin, xmax, ymax), npts = glyph_data(contours)
    glyf = glyf1
    loca = struct.pack('>III', 0, 0, len(glyf1))       # гліф 0 (.notdef) — порожній
    head = struct.pack('>IIIIHHqqhhhhHHhhh', 0x00010000, 0x00010000, 0, 0x5F0F3CF5, 0x000B, EM, 0, 0,
                       xmin, ymin, xmax, ymax, 0, 8, 2, 1, 0)
    hhea = struct.pack('>IhhhHhhhhhh4hhH', 0x00010000, EM, 0, 0, EM, 0, EM - xmax, xmax, 1, 0, 0,
                       0, 0, 0, 0, 0, 2)
    maxp = struct.pack('>IHHHHHHHHHHHHHH', 0x00010000, 2, npts, len(contours), 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
    hmtx = struct.pack('>HhHh', EM, 0, EM, xmin)
    os2 = struct.pack('>HhHHH10hh10s4I4sHHHhhhHH2IhhHHH',
                      4, EM, 400, 5, 0,
                      650, 600, 0, 75, 650, 600, 0, 350, 50, 300,
                      0, b'\0' * 10, 0, 1 << 28, 0, 0, b'FGJO', 0x40, CODEPOINT, CODEPOINT,  # bit 60: Private Use Area
                      EM, 0, 0, EM, 0, 1, 0, 0, 0, 0, 0x20, 1)
    post = struct.pack('>IIhhIIIII', 0x00030000, 0, -100, 50, 1, 0, 0, 0, 0)
    name = name_table([(1, 'Forgejo Connector Icons'), (2, 'Regular'), (3, 'Forgejo Connector Icons'),
                       (4, 'Forgejo Connector Icons'), (5, 'Version 1.0'), (6, 'ForgejoConnectorIcons')])
    tables = {b'OS/2': os2, b'cmap': cmap_table(), b'glyf': glyf, b'head': head, b'hhea': hhea,
              b'hmtx': hmtx, b'loca': loca, b'maxp': maxp, b'name': name, b'post': post}

    n = len(tables)
    entry = 2 ** int(math.log2(n))
    out = struct.pack('>IHHHH', 0x00010000, n, entry * 16, int(math.log2(n)), n * 16 - entry * 16)
    offset = 12 + 16 * n
    directory, body, head_offset = b'', b'', 0
    for tag in sorted(tables):
        data = tables[tag]
        if tag == b'head':
            head_offset = offset
        directory += struct.pack('>4sIII', tag, checksum(data), offset, len(data))
        padded = data + b'\0' * (-len(data) % 4)
        body += padded
        offset += len(padded)
    font = bytearray(out + directory + body)
    # head.checkSumAdjustment — після складання всього файлу
    struct.pack_into('>I', font, head_offset + 8, (0xB1B0AFBA - checksum(bytes(font))) & 0xFFFFFFFF)
    path.write_bytes(bytes(font))


def main():
    make_png(ROOT / 'icon.png')
    (ROOT / 'media').mkdir(exist_ok=True)
    make_font(ROOT / 'media' / 'forgejo.ttf')
    print(ROOT / 'icon.png')
    print(ROOT / 'media' / 'forgejo.ttf')


if __name__ == '__main__':
    main()
