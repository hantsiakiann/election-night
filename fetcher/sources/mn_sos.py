"""Minnesota Secretary of State media results files.

Semicolon-delimited text, latin-1, '|' as quote char, one row per candidate. Columns
(as used by MinnPost's long-running election-night scraper):
  0 state  1 county id  2 precinct id  3 office id  4 office name  5 district
  6 candidate order  7 candidate name  8 suffix  9 incumbent  10 party
  11 precincts reporting  12 total precincts  13 votes  14 pct  15 total votes in office
Statewide files (ussenate.txt, ushouse.txt, ...) carry one row per candidate per contest.
"""
from __future__ import annotations

import csv
import io

from ..model import clean_candidate


def load(cfg: dict, get) -> dict:
    base = cfg["base"].rstrip("/") + "/"
    contests: dict[str, dict] = {}
    seen = set()
    for fname in cfg.get("files", []):
        raw = get(base + fname)
        rows = csv.reader(io.StringIO(raw.decode("latin-1")), delimiter=";", quotechar="|")
        for r in rows:
            if len(r) < 16:
                continue
            key = (r[3], r[5], r[1], r[2], r[6])
            if key in seen:
                continue
            seen.add(key)
            cname = r[4].strip()
            c = contests.setdefault(cname, {"id": cname, "name": cname, "vote_for": 1,
                                            "_cands": {}, "precincts_reporting": 0,
                                            "precincts_total": 0, "_units": set()})
            unit = (r[1], r[2])
            if unit not in c["_units"]:  # count precincts once per reporting unit
                c["_units"].add(unit)
                c["precincts_reporting"] += int(r[11] or 0)
                c["precincts_total"] += int(r[12] or 0)
            name, party, inc = clean_candidate(r[7], r[10])
            slot = c["_cands"].setdefault(r[6], {"name": name, "party": party,
                                                  "incumbent": inc or r[9].strip().upper() in ("I", "Y", "TRUE"),
                                                  "votes": 0, "order": len(c["_cands"])})
            slot["votes"] += int(r[13] or 0)
    for c in contests.values():
        c["candidates"] = list(c.pop("_cands").values())
        c.pop("_units")
    return {"updated": None, "page": cfg.get("page"), "contests": contests}
