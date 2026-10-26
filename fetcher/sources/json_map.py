"""Generic adapter for any state that publishes results as JSON.

Map the feed's field names in config/races.yml instead of writing code. Paths are dotted
("data.contests"), integers index lists ("races.0.choices"), and "" means the root.

    az:
      type: json_map
      url: https://example.gov/results.json
      page: https://example.gov/results
      contests: "Contests"              # path to the list of contests
      contest_name: "Name"              # relative to each contest
      candidates: "Choices"             # relative to each contest
      cand_name: "Name"
      cand_votes: "Votes"
      cand_party: "Party"               # optional
      precincts_reporting: "Reporting"  # optional, relative to each contest
      precincts_total: "Precincts"      # optional
      reporting_pct: ""                 # optional alternative: a percent field
      updated: "LastUpdated"            # optional, from the root

Run `python -m fetcher.probe <url>` to print a feed's structure while filling this in.
"""
from __future__ import annotations

import json

from ..model import clean_candidate


def pick(obj, path: str | None):
    if not path:
        return obj
    for part in path.split("."):
        if obj is None:
            return None
        if isinstance(obj, list):
            obj = obj[int(part)] if part.lstrip("-").isdigit() and int(part) < len(obj) else None
        else:
            obj = obj.get(part)
    return obj


def _num(v):
    if v in (None, ""):
        return None
    try:
        return int(str(v).replace(",", ""))
    except ValueError:
        return int(float(v))


def load(cfg: dict, get) -> dict:
    data = json.loads(get(cfg["url"]).decode("utf-8-sig"))
    contests = {}
    for item in pick(data, cfg.get("contests")) or []:
        cname = str(pick(item, cfg["contest_name"]) or "").strip()
        if not cname:
            continue
        cands = []
        for i, ch in enumerate(pick(item, cfg["candidates"]) or []):
            name, party, inc = clean_candidate(str(pick(ch, cfg["cand_name"]) or ""),
                                               pick(ch, cfg.get("cand_party")) if cfg.get("cand_party") else None)
            cands.append({"name": name, "party": party, "incumbent": inc,
                          "votes": _num(pick(ch, cfg["cand_votes"])) or 0, "order": i})
        c = {"id": cname, "name": cname, "vote_for": 1, "candidates": cands,
             "precincts_reporting": _num(pick(item, cfg.get("precincts_reporting"))) if cfg.get("precincts_reporting") else None,
             "precincts_total": _num(pick(item, cfg.get("precincts_total"))) if cfg.get("precincts_total") else None}
        if cfg.get("reporting_pct"):
            rp = pick(item, cfg["reporting_pct"])
            c["reporting_pct"] = float(str(rp).rstrip("%")) if rp not in (None, "") else None
        contests[cname] = c
    return {"updated": pick(data, cfg.get("updated")) if cfg.get("updated") else None,
            "page": cfg.get("page"), "contests": contests}
