"""Build config/ratings.yml: Cook, Sabato's Crystal Ball and Inside Elections ratings for every
2026 Senate, governor and House race, read from 270toWin's per-forecaster maps.

    python tools/build_ratings.py                 # fetch from 270toWin (run in GitHub Actions)
    python tools/build_ratings.py --from-dir DIR  # use saved pages named like the URL slugs

Each 270toWin map page embeds its ratings as a string with one character per race:
  House    435 chars, states in abbreviation order, districts 1..n within each state
  Senate   two chars per state (both seats), states in abbreviation order; '9' = not up
  Governor one char per state, abbreviation order; '9' = not up
Characters: 1/3/5/a = Safe/Likely/Lean/Tilt D, 2/4/6/b = the same for R, 0 = Toss-up,
g/h/j/k = Safe/Likely/Lean/Tilt independent. The script checks that the races it finds match
the 2026 race list exactly and exits non-zero otherwise.
"""
import argparse
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fetcher.states import GOVERNOR_2026, SENATE_2026, STATES  # noqa: E402

BASE = "https://www.270towin.com"
PAGES = {
    ("house", "Cook"): "/2026-house-election/cook-political-report-2026-house-ratings",
    ("house", "Sabato"): "/2026-house-election/crystal-ball-2026-house-forecast",
    ("house", "Inside Elections"): "/2026-house-election/inside-elections-2026-house-ratings",
    ("senate", "Cook"): "/2026-senate-election/cook-political-report-2026-senate",
    ("senate", "Sabato"): "/2026-senate-election/sabatos-crystal-ball-senate-2026",
    ("senate", "Inside Elections"): "/2026-senate-election/inside-elections-2026-senate-ratings",
    ("governor", "Cook"): "/2026-governor-election/cook-political-report-2026-governor",
    ("governor", "Sabato"): "/2026-governor-election/sabatos-crystal-ball-2026-governor",
    ("governor", "Inside Elections"): "/2026-governor-election/inside-elections-governor-2026",
}
CTOR = {"house": "HouseMultiDistrictsMap", "senate": "SenateMap", "governor": "GovernorMap"}
# Each forecaster's own word for its least competitive category.
SAFE = {"Cook": "Solid", "Sabato": "Safe", "Inside Elections": "Solid"}
LEVEL = {"1": 0, "2": 0, "g": 0, "3": 1, "4": 1, "h": 1, "5": 2, "6": 2, "j": 2, "a": 3, "b": 3, "k": 3}
SIDE = {"1": "D", "3": "D", "5": "D", "a": "D", "2": "R", "4": "R", "6": "R", "b": "R",
        "g": "I", "h": "I", "j": "I", "k": "I"}


def label(code, forecaster):
    if code == "0":
        return "Toss-up"
    if code not in LEVEL:
        return None
    word = [SAFE[forecaster], "Likely", "Lean", "Tilt"][LEVEL[code]]
    return f"{word} {SIDE[code]}"


def fetch(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0 (election-night tracker)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def parse(html, group):
    m = re.search(r"new %s\('([0-9a-z]+)'" % CTOR[group], html)
    if not m:
        raise ValueError(f"no {CTOR[group]} string on page")
    when = re.search(r"date_created_formatted = '([^']*)'", html)
    return m.group(1), (when.group(1) if when else None)


def decode(group, s):
    abbrs = sorted(st[0] for st in STATES)
    seats = {st[0]: st[3] for st in STATES}
    out = {}
    if group == "house":
        ids = [f"H-{a}-AL" if seats[a] == 1 else f"H-{a}-{n:02d}" for a in abbrs for n in range(1, seats[a] + 1)]
        if len(s) != len(ids):
            raise ValueError(f"house string has {len(s)} chars, expected {len(ids)}")
        out = dict(zip(ids, s))
    elif group == "senate":
        for i, a in enumerate(abbrs):
            up = [c for c in s[2 * i:2 * i + 2] if c != "9"]
            if up:
                out[f"SEN-{a}"] = up[0]
    else:
        out = {f"GOV-{a}": c for a, c in zip(abbrs, s) if c != "9"}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-dir", type=Path)
    ap.add_argument("--out", default="config/ratings.yml")
    args = ap.parse_args(argv)

    expected = {"senate": {f"SEN-{a}" for a in SENATE_2026}, "governor": {f"GOV-{a}" for a in GOVERNOR_2026}}
    result = {"house": {}, "senate": {}, "governor": {}}
    as_of, problems = {}, []
    for (group, who), path in PAGES.items():
        try:
            html = (args.from_dir / (path.rsplit("/", 1)[1] + ".html")).read_text() if args.from_dir else fetch(path)
            s, when = parse(html, group)
            codes = decode(group, s)
        except Exception as e:  # keep going; report at the end
            problems.append(f"{group}/{who}: {e}")
            continue
        if group in expected and set(codes) != expected[group]:
            problems.append(f"{group}/{who}: races {sorted(set(codes) ^ expected[group])} don't match the 2026 list")
            continue
        as_of[f"{who} {group}"] = when
        for rid, code in codes.items():
            lab = label(code, who)
            if lab:
                result[group].setdefault(rid, {})[who] = lab
            else:
                problems.append(f"{group}/{who}: unknown code {code!r} for {rid}")

    order = ["Cook", "Sabato", "Inside Elections"]
    doc = {
        "_note": "Generated by tools/build_ratings.py from 270toWin's forecaster maps. Don't edit by hand.",
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "as_of": as_of,
    }
    for group in ("senate", "governor", "house"):
        doc[group] = {rid: {k: r[k] for k in order if k in r} for rid, r in sorted(result[group].items())}
    Path(args.out).write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=200))
    counts = {g: len(doc[g]) for g in ("senate", "governor", "house")}
    print(f"wrote {args.out}: {counts}")
    for p in problems:
        print("!!", p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
