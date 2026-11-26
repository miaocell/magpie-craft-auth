"""只用标准库把 PNG 解开，输出紫色区域与内部孔洞的 SVG 路径。"""

import struct
import sys
import zlib


def load_png(path):
    d = open(path, 'rb').read()
    pos, idat, w, h = 8, b'', 0, 0
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        data = d[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h = struct.unpack('>II', data[:8])
        elif typ == b'IDAT':
            idat += data
        pos += 12 + ln
    raw = zlib.decompress(idat)
    bpp, stride = 4, w * 4
    prev, rows, i = bytearray(stride), [], 0
    for _ in range(h):
        f = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, rows


def purple_mask(w, h, rows):
    m = [[False] * w for _ in range(h)]
    for y in range(h):
        r = rows[y]
        for x in range(w):
            px = r[x * 4:x * 4 + 4]
            if px[3] > 128 and px[0] < 190:
                m[y][x] = True
    return m


def holes(mask, w, h):
    """从边界洪泛标记外部；剩下的非紫色格子就是内部孔洞。"""
    outside = [[False] * w for _ in range(h)]
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if not mask[y][x] and not outside[y][x]:
                outside[y][x] = True
                stack.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y][x] and not outside[y][x]:
                outside[y][x] = True
                stack.append((x, y))
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not mask[ny][nx] and not outside[ny][nx]:
                outside[ny][nx] = True
                stack.append((nx, ny))
    return [[not mask[y][x] and not outside[y][x] for x in range(w)] for y in range(h)]


def trace(mask, w, h):
    edge = {}
    for y in range(h):
        for x in range(w):
            if not mask[y][x]:
                continue
            if y == 0 or not mask[y - 1][x]:
                edge.setdefault((x, y), []).append((x + 1, y))
            if x == w - 1 or not mask[y][x + 1]:
                edge.setdefault((x + 1, y), []).append((x + 1, y + 1))
            if y == h - 1 or not mask[y + 1][x]:
                edge.setdefault((x + 1, y + 1), []).append((x, y + 1))
            if x == 0 or not mask[y][x - 1]:
                edge.setdefault((x, y + 1), []).append((x, y))
    loops, seen = [], set()
    for start in edge:
        if start in seen:
            continue
        loop, cur = [], start
        while cur not in seen:
            seen.add(cur)
            loop.append(cur)
            nxts = edge.get(cur)
            if not nxts:
                break
            cur = nxts.pop()
        if len(loop) > 40:
            loops.append(loop)
    loops.sort(key=len, reverse=True)
    return loops


def dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5


def simplify(pts, eps):
    if len(pts) < 3:
        return pts
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = dist(pts[i], pts[0], pts[-1])
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return simplify(pts[:idx + 1], eps)[:-1] + simplify(pts[idx:], eps)
    return [pts[0], pts[-1]]


def to_path(pts, s):
    return ''.join(
        ('M' if i == 0 else 'L') + f'{x * s:.2f} {y * s:.2f}' for i, (x, y) in enumerate(pts)
    ) + 'Z'


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'logo256.png'
    w, h, rows = load_png(src)
    pm = purple_mask(w, h, rows)
    hl = holes(pm, w, h)

    s = 64.0 / w
    outer = trace(pm, w, h)
    inner = trace(hl, w, h)

    eps_o = float(sys.argv[2]) if len(sys.argv) > 2 else 1.1
    eps_i = float(sys.argv[3]) if len(sys.argv) > 3 else 0.9

    print(f'# 外轮廓环数 {len(outer)}，孔洞环数 {len(inner)}')
    if outer:
        so = simplify(outer[0], eps_o)
        print(f'# 外轮廓 {len(outer[0])} → {len(so)} 点')
        print('OUTER=' + to_path(so, s))
    if inner:
        si = simplify(inner[0], eps_i)
        print(f'# 孔洞 {len(inner[0])} → {len(si)} 点')
        print('INNER=' + to_path(si, s))
