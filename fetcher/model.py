"""Normalized race model shared by every source adapter.

Adapters return "contests":
    {"name": str, "vote_for": int,
     "candidates": [{"name", "party", "votes", "incumbent"}],
     "precincts_reporting": int|None, "precincts_total": int|None}

`finalize()` turns a contest into the race object the page renders.
"""
from __future__ import annotations

import re

PARTY_MAP = {
    "rep": "R", "republican": "R", "r": "R",
    "dem": "D", "democrat": "D", "democratic": "D", "d": "D", "dfl": "D",
    "lib": "L", "libertarian": "L", "lp": "L",
    "grn": "G", "green": "G", "gp": "G", "gre": "G", "g": "G",
    "ind": "I", "independent": "I", "i": "I", "una": "I", "unaffiliated": "I", "npa": "I",
    "no party affiliation": "I", "no party preference": "I", "npp": "I", "nonaffiliated": "I",
    "con": "C", "cst": "C", "constitution": "C", "c": "C",
    "wfp": "WF", "wf": "WF", "working families": "WF",
    "np": "", "nonpartisan": "", "non-partisan": "", "": "",
}

# Trailing party marker inside a candidate name: "Jane Doe (Rep)" / "Jane Doe - Dem"
_NAME_PARTY = re.compile(r"\s*(?:\((rep|dem|lib|grn|ind|con|cst|wfp)\)|-\s*(rep|dem|lib|grn|ind|con|cst|wfp))\s*$", re.I)
# Incumbent marker: "(I)" left after the party marker is removed
_INCUMBENT = re.compile(r"\s*\(I\)\s*$")
_YES_NO = {"yes", "no", "for", "against"}


def norm_party(p: str | None) -> str:
    if not p:
        return ""
    k = p.strip().strip("()").lower()
    return PARTY_MAP.get(k, p.strip()[:3].upper())


def clean_candidate(name: str, party: str | None) -> tuple[str, str, bool]:
    """Split a feed's candidate label into (name, party code, incumbent)."""
    name = (name or "").strip()
    m = _NAME_PARTY.search(name)
    if m:
        name = name[: m.start()].strip()
        party = party or (m.group(1) or m.group(2))
    incumbent = bool(_INCUMBENT.search(name))
    if incumbent:
        name = _INCUMBENT.sub("", name).strip()
    return name, norm_party(party), incumbent


def is_measure(contest: dict) -> bool:
    names = {c["name"].strip().lower() for c in contest.get("candidates", [])}
    return bool(names) and names <= _YES_NO


def finalize(contest: dict, *, race_id: str, title: str | None = None,
             source: str, source_url: str | None = None, updated: str | None = None,
             majority_rule: bool = False, extra: dict | None = None) -> dict:
    cands = [dict(c) for c in contest.get("candidates", [])]
    total = sum(c.get("votes") or 0 for c in cands)
    for i, c in enumerate(cands):
        c.setdefault("order", i)
        c["pct"] = round(100 * c["votes"] / total, 2) if total else 0.0
    if total:
        cands.sort(key=lambda c: (-c["votes"], c["order"]))
    else:  # before votes: Democrat, Republican, other parties, independents last
        rank = {"D": 0, "R": 1, "I": 3}
        cands.sort(key=lambda c: (rank.get(c.get("party"), 2), c["order"]))
    measure = is_measure(contest)
    vote_for = contest.get("vote_for") or 1

    pr, pt = contest.get("precincts_reporting"), contest.get("precincts_total")
    reporting_pct = None
    if contest.get("reporting_pct") is not None:
        reporting_pct = float(contest["reporting_pct"])
    elif pr is not None and pt:
        reporting_pct = round(100 * pr / pt, 1)

    race = {
        "id": race_id,
        "title": title or contest.get("name"),
        "feed_name": contest.get("name"),
        "candidates": [{k: c[k] for k in ("name", "party", "votes", "pct", "incumbent") if k in c}
                       for c in cands],
        "total_votes": total,
        "vote_for": vote_for,
        "measure": measure,
        "precincts_reporting": pr,
        "precincts_total": pt,
        "reporting_pct": reporting_pct,
        "status": "live" if cands else "empty",
        "source": source,
        "source_url": source_url,
        "updated": updated,
    }
    if total and len(cands) >= 2 and vote_for == 1:
        a, b = cands[0], cands[1]
        race["margin_pct"] = round(a["pct"] - b["pct"], 2)
        race["margin_votes"] = a["votes"] - b["votes"]
        race["leader"] = a["name"]
        race["leader_party"] = a.get("party", "")
    # Georgia (and a few others) require a majority; flag when the leader is under 50%.
    if majority_rule and total and not measure and vote_for == 1 and len(cands) > 2:
        race["below_majority"] = cands[0]["pct"] <= 50.0
    # County breakdown: [[county, reporting %, [votes in the same order as race candidates]], ...]
    county_rows = contest.get("county_results") or []
    if len(county_rows) >= 2:
        names = [c["name"] for c in cands]
        rows = []
        for cr in sorted(county_rows, key=lambda r: r["name"]):
            pt = cr.get("pt")
            rp = round(100 * cr["pr"] / pt, 1) if pt else None
            rows.append([cr["name"], rp, [int(cr["votes"].get(n, 0)) for n in names]])
        race["counties"] = rows
        race["statewide"] = bool(contest.get("statewide"))
    if extra:
        race.update(extra)
    return race
