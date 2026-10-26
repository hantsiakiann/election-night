"""Generate the House tile map: one equal-size square per district, states roughly in
their real shape and position.

    pip install shapely numpy
    python tools/make_house_grid.py            # writes site/geo/house_grid.json

Method (a grid "diffusion" cartogram):
1. Rasterize the real lower-48 map (site/geo/states.json) onto a square grid at a resolution
   giving about one cell per district. Each state starts with cells in proportion to its area.
2. Repeatedly move one border cell at a time from a state with too many cells to an
   adjacent state with relatively more need (or to/from empty space at the map's edge),
   never breaking a state into pieces. Repeat until every state has exactly its seat count.
Alaska and Hawaii are placed as insets at the bottom left.
"""
import json
import math
import random
import sys
from collections import deque
from pathlib import Path

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from fetcher.states import STATES  # noqa: E402

SEATS = {s[0]: s[3] for s in STATES}
FIPS = {s[2]: s[0] for s in STATES}
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))


def decode_arcs(topo):
    tr = topo.get("transform")
    arcs = []
    for arc in topo["arcs"]:
        pts, x, y = [], 0, 0
        for p in arc:
            if tr:
                x, y = x + p[0], y + p[1]
                pts.append((x * tr["scale"][0] + tr["translate"][0], y * tr["scale"][1] + tr["translate"][1]))
            else:
                pts.append(tuple(p))
        arcs.append(np.array(pts, dtype=float))
    return arcs


def build_shapes(topo, arcs):
    def ring(idx):
        out = []
        for i in idx:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(map(tuple, a if not out else a[1:]))
        return out

    shapes = {}
    for g in topo["objects"]["states"]["geometries"]:
        parts = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        polys = [Polygon(ring(p[0]), [ring(h) for h in p[1:]]).buffer(0) for p in parts]
        shapes[g["id"]] = unary_union(polys)
    return shapes


def cartogram(topo, arcs, targets, iterations=25):
    """Dougenik-Chrisman-Niemeyer rubber-sheet cartogram on shared arcs (keeps borders aligned).
    targets: {fips: desired share}. Returns moved arcs."""
    arcs = [a.copy() for a in arcs]
    ids = [g["id"] for g in topo["objects"]["states"]["geometries"] if g["id"] in targets]
    for it in range(iterations):
        shapes = build_shapes(topo, arcs)
        areas = np.array([shapes[i].area for i in ids])
        total = areas.sum()
        desired = np.array([targets[i] for i in ids]) * total
        cents = np.array([shapes[i].centroid.coords[0] for i in ids])
        radius = np.sqrt(areas / math.pi)
        mass = np.sqrt(desired / math.pi) - radius
        size_error = np.mean(np.maximum(desired, areas) / np.minimum(desired, areas))
        reduce = 1.0 / (1.0 + size_error)
        for k, a in enumerate(arcs):
            d = np.linalg.norm(a[:, None, :] - cents[None, :, :], axis=2)  # points x states
            d = np.maximum(d, 1e-9)
            r = radius[None, :]
            f = np.where(d > r, mass * r / d, mass * (d ** 2 / r ** 2) * (4 - 3 * d / r))
            direction = (a[:, None, :] - cents[None, :, :]) / d[:, :, None]
            arcs[k] = a + (direction * f[:, :, None]).sum(axis=1) * reduce
    return arcs


def rasterize(shapes, states, u):
    minx = min(shapes[a].bounds[0] for a in states)
    miny = min(shapes[a].bounds[1] for a in states)
    maxx = max(shapes[a].bounds[2] for a in states)
    maxy = max(shapes[a].bounds[3] for a in states)
    grid = {}
    for j, y in enumerate(np.arange(miny, maxy + u, u)):
        for i, x in enumerate(np.arange(minx, maxx + u, u)):
            p = Point(x + u / 2, y + u / 2)
            for a in states:
                if shapes[a].contains(p):
                    grid[(i, j)] = a
                    break
    # keep each state's largest connected piece (drops e.g. Virginia's Eastern Shore)
    for a in states:
        mine = [k for k, v in grid.items() if v == a]
        comps, seen = [], set()
        for start in mine:
            if start in seen:
                continue
            comp, q = {start}, deque([start])
            seen.add(start)
            while q:
                i, j = q.popleft()
                for di, dj in N4:
                    n = (i + di, j + dj)
                    if grid.get(n) == a and n not in seen:
                        seen.add(n)
                        comp.add(n)
                        q.append(n)
            comps.append(comp)
        for comp in sorted(comps, key=len)[:-1]:
            for k in comp:
                del grid[k]
    # every state needs at least one cell: seed tiny states at a point inside them
    have = set(grid.values())
    for a in states:
        if a not in have:
            cx, cy = shapes[a].representative_point().coords[0]
            grid[(int((cx - minx) // u), int((cy - miny) // u))] = a
    return grid


def in_one_piece(grid, a, removed=None):
    """Is state `a` a single connected block (optionally with one cell removed)?"""
    mine = [k for k, v in grid.items() if v == a and k != removed]
    if not mine:
        return False
    seen, q = {mine[0]}, deque([mine[0]])
    while q:
        i, j = q.popleft()
        for di, dj in N4:
            n = (i + di, j + dj)
            if n != removed and grid.get(n) == a and n not in seen:
                seen.add(n)
                q.append(n)
    return len(seen) == len(mine)


def exterior(grid):
    """Empty cells connected to the outside of the map (anything else empty is a hole)."""
    xs = [i for i, _ in grid]
    ys = [j for _, j in grid]
    x0, x1, y0, y1 = min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1
    seen, q = {(x0, y0)}, deque([(x0, y0)])
    while q:
        i, j = q.popleft()
        for di, dj in N4:
            n = (i + di, j + dj)
            if x0 <= n[0] <= x1 and y0 <= n[1] <= y1 and n not in grid and n not in seen:
                seen.add(n)
                q.append(n)
    return seen


def holes(grid):
    ext = exterior(grid)
    xs = [i for i, _ in grid]
    ys = [j for _, j in grid]
    return [(i, j) for i in range(min(xs), max(xs) + 1) for j in range(min(ys), max(ys) + 1)
            if (i, j) not in grid and (i, j) not in ext]


def balance(grid, states, max_steps=5000):
    count = {a: 0 for a in states}
    for v in grid.values():
        count[v] += 1

    def ex(a):  # cells still needed (> 0) or in surplus (< 0)
        return SEATS[a] - count[a]

    def own_nbrs(cell, a):
        return sum(grid.get((cell[0] + di, cell[1] + dj)) == a for di, dj in N4)

    def apply(kind, cell, a, b=None):
        if kind == "claim":
            grid[cell] = a
            count[a] += 1
        elif kind == "release":
            del grid[cell]
            count[a] -= 1
        else:
            grid[cell] = b
            count[a] -= 1
            count[b] += 1

    def candidates():
        out = []
        ext = exterior(grid)
        for cell, a in list(grid.items()):
            for di, dj in N4:
                n = (cell[0] + di, cell[1] + dj)
                b = grid.get(n)
                if b == a:
                    continue
                if b is None:
                    if ex(a) >= 1:  # grow into empty space; holes first, then notches
                        out.append((ex(a) + 0.2 * own_nbrs(n, a) + (3 if n not in ext else 0), "claim", n, a, None))
                    if ex(a) <= -1 and n in ext:  # shrink only at the outer edge (never opens a hole)
                        out.append((-ex(a) - 0.2 * own_nbrs(cell, a), "release", cell, a, None))
                elif ex(b) - ex(a) >= 2:  # give to a needier neighbor; >= 2 so it can't bounce back
                    out.append((ex(b) - ex(a) - 0.2 * own_nbrs(cell, a) + 0.2 * own_nbrs(cell, b), "move", cell, a, b))
        out.sort(key=lambda c: -c[0])
        return out

    # phase 1: local diffusion
    for step in range(max_steps):
        if all(ex(a) == 0 for a in states):
            return step
        done = False
        for _, kind, cell, a, b in candidates():
            if kind == "claim" or (count[a] > 1 and in_one_piece(grid, a, cell)):
                apply(kind, cell, a, b)
                done = True
                break
        if not done:
            break

    # phase 2: route leftover surplus to leftover need along chains of neighboring states
    EMPTY = "~"

    def state_graph():
        g = {a: set() for a in states}
        g[EMPTY] = set()
        for cell, a in grid.items():
            for di, dj in N4:
                b = grid.get((cell[0] + di, cell[1] + dj), EMPTY)
                if b != a:
                    g[a].add(b)
                    g[b].add(a)
        return g

    def give_one(a, b):
        """Move one border cell from a to b (b may be EMPTY = release; a may be EMPTY = claim)."""
        if a == EMPTY:
            opts = [((cell[0] + di, cell[1] + dj), own_nbrs((cell[0] + di, cell[1] + dj), b))
                    for cell, v in grid.items() if v == b for di, dj in N4
                    if (cell[0] + di, cell[1] + dj) not in grid]
            if not opts:
                return False
            n = max(opts, key=lambda o: o[1])[0]
            apply("claim", n, b)
            return True
        opts = []
        ext = exterior(grid) if b == EMPTY else set()
        for cell, v in grid.items():
            if v != a:
                continue
            for di, dj in N4:
                n = (cell[0] + di, cell[1] + dj)
                nb = grid.get(n, EMPTY)
                if nb == b and (b != EMPTY or n in ext):
                    opts.append((own_nbrs(cell, a) - (own_nbrs(cell, b) if b != EMPTY else 0), cell))
                    break
        for _, cell in sorted(opts):
            if count[a] > 1 and in_one_piece(grid, a, cell):
                apply("release" if b == EMPTY else "move", cell, a, b)
                return True
        return False

    for _ in range(500):
        if all(ex(a) == 0 for a in states):
            return "routed"
        g = state_graph()
        sources = [a for a in states if ex(a) < 0] or [EMPTY]
        sinks = {a for a in states if ex(a) > 0} or {EMPTY}
        progressed = False
        for src in sources:
            prev, q = {src: None}, deque([src])
            target = None
            while q and target is None:
                x = q.popleft()
                for y in g[x]:
                    if y not in prev:
                        prev[y] = x
                        if y in sinks or (y == EMPTY and src != EMPTY):
                            target = y
                            break
                        if y != EMPTY:
                            q.append(y)
            if target is None:
                continue
            path, x = [], target
            while x is not None:
                path.append(x)
                x = prev[x]
            path.reverse()  # src ... target
            ok = all(give_one(path[i], path[i + 1]) for i in range(len(path) - 2, -1, -1))
            progressed = progressed or ok
            break
        if not progressed:
            return None
    return None


def main():
    topo = json.loads((ROOT / "site/geo/states.json").read_text())
    arcs = decode_arcs(topo)
    abbr_of = {g["id"]: FIPS[g["id"]] for g in topo["objects"]["states"]["geometries"] if g["id"] in FIPS}
    lower48_fips = [f for f, a in abbr_of.items() if a not in ("AK", "HI")]
    seats48 = sum(SEATS[abbr_of[f]] for f in lower48_fips)
    arcs = cartogram(topo, arcs, {f: SEATS[abbr_of[f]] / seats48 for f in lower48_fips})
    shapes = {abbr_of[k]: v for k, v in build_shapes(topo, arcs).items() if k in abbr_of}
    lower48 = [a for a in shapes if a not in ("AK", "HI")]
    err = {a: round(shapes[a].area / sum(shapes[b].area for b in lower48) * seats48, 1) for a in lower48}
    print("cartogram seats-equivalent (target = seats):",
          {a: (err[a], SEATS[a]) for a in lower48 if abs(err[a] - SEATS[a]) > 1}, file=sys.stderr)
    target = sum(SEATS[a] for a in lower48)
    area = sum(shapes[a].area for a in lower48)
    u = math.sqrt(area / target)
    grid = rasterize(shapes, lower48, u)
    steps = balance(grid, lower48)
    for _round in range(60):  # fill interior gaps: a neighbor claims each hole, then rebalance
        hs = holes(grid)
        if not hs:
            break
        for h in hs:
            if h in grid:
                continue
            nbrs = [grid.get((h[0] + di, h[1] + dj)) for di, dj in N4]
            nbrs = [n for n in nbrs if n]
            if nbrs:
                grid[h] = max(set(nbrs), key=nbrs.count)
        steps = balance(grid, lower48)
    counts = {a: sum(1 for v in grid.values() if v == a) for a in lower48}
    bad = {a: (counts[a], SEATS[a]) for a in lower48 if counts[a] != SEATS[a]}
    broken = [a for a in lower48 if not in_one_piece(grid, a)]
    i0 = min(i for i, _ in grid)
    j0 = min(j for _, j in grid)
    H = max(j for _, j in grid) - j0 + 1
    cells = [{"s": a, "x": i - i0, "y": j - j0} for (i, j), a in grid.items()]
    # Alaska and Hawaii: just below the West Coast's southern edge, not the bottom of the map
    west = [c for c in cells if c["x"] <= 5]
    yi = max(c["y"] for c in west) + 2
    taken = {(c["x"], c["y"]) for c in cells}
    while any((x, yi) in taken for x in range(0, 4)):
        yi += 1
    cells += [{"s": "AK", "x": 0, "y": yi}, {"s": "HI", "x": 2, "y": yi}, {"s": "HI", "x": 3, "y": yi}]
    return cells, {"steps": steps, "unbalanced": bad, "broken": broken, "holes": len(holes(grid))}


def write(cells):
    by_state = {}
    for c in sorted(cells, key=lambda c: (c["y"], c["x"])):  # number districts top-left to bottom-right
        by_state.setdefault(c["s"], []).append(c)
    out = [[s, n, c["x"], c["y"]] for s, lst in by_state.items() for n, c in enumerate(lst, 1)]
    W = max(c["x"] for c in cells) + 1
    H = max(c["y"] for c in cells) + 1
    path = ROOT / "site/geo/house_grid.json"
    path.write_text(json.dumps({"w": W, "h": H, "cells": out}, separators=(",", ":")))
    return path


if __name__ == "__main__":
    cells, info = main()
    print(len(cells), "cells", info)
    if not info["unbalanced"] and not info["broken"] and not info["holes"] and len(cells) == 435:
        print("wrote", write(cells))
    else:
        sys.exit("layout not valid; not written")
