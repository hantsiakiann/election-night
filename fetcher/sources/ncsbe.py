"""North Carolina State Board of Elections precinct results.

  https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/{YYYY_MM_DD}/results_pct_{YYYYMMDD}.zip
A zip holding one tab-separated file, one row per precinct x contest x choice. Columns used:
  County, Precinct, Contest Name, Choice, Choice Party, Vote For, Total Votes, Real Precinct
This file has no "precincts reporting" field, so we count real precincts that have any votes
in the contest as a rough proxy (it overstates early in the night when only early votes post).
"""
from __future__ import annotations

import csv
import io
import zipfile

from ..model import clean_candidate


def load(cfg: dict, get) -> dict:
    raw = get(cfg["url"])
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        text = "\n".join(z.read(n).decode("utf-8-sig", "replace") for n in z.namelist()
                         if n.lower().endswith((".txt", ".tsv", ".csv")))
    contests: dict[str, dict] = {}
    precincts: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(text), delimiter="\t"):
        cname = (row.get("Contest Name") or "").strip()
        if not cname:
            continue
        c = contests.setdefault(cname, {"id": cname, "name": cname,
                                        "vote_for": int(row.get("Vote For") or 1),
                                        "_cands": {}})
        choice = (row.get("Choice") or "").strip()
        votes = int(float(row.get("Total Votes") or 0))
        slot = c["_cands"].setdefault(choice, {"votes": 0, "party": row.get("Choice Party"),
                                                "order": len(c["_cands"])})
        slot["votes"] += votes
        if (row.get("Real Precinct") or "Y").upper() == "Y":
            key = f"{row.get('County')}|{row.get('Precinct')}"
            p = precincts.setdefault(cname, {})
            p[key] = p.get(key, 0) + votes

    for cname, c in contests.items():
        cands = []
        for choice, s in c.pop("_cands").items():
            name, party, inc = clean_candidate(choice, s["party"])
            cands.append({"name": name, "party": party, "incumbent": inc,
                          "votes": s["votes"], "order": s["order"]})
        c["candidates"] = cands
        p = precincts.get(cname, {})
        c["precincts_total"] = len(p) or None
        c["precincts_reporting"] = sum(1 for v in p.values() if v > 0) if p else None
    return {"updated": None, "page": cfg.get("page"), "contests": contests}
