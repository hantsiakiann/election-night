"""Georgia Secretary of State results (Enhanced Voting media export).

Spec: "Media Reporting - A Guide to Enhanced Results JSON Media Export" (GA SOS, Sept 2024).
  JSON: {base}/export-{election_id}.json   (ZIP of the same at .zip, much smaller)
  - results.ballotItems: federal + state contests, aggregated statewide (no precinct counts)
  - localResults[]: one entry per county; every contest on that county's ballot, with
    precinctsParticipating / precinctsReporting ("reporting" = fully OR partially)
The state caches the file; polling faster than once a minute only returns cached data.
"""
from __future__ import annotations

import io
import json
import zipfile

from ..model import clean_candidate


def _contest(bi: dict, with_precincts: bool) -> dict:
    cands = []
    for i, opt in enumerate(sorted(bi.get("ballotOptions") or [], key=lambda o: o.get("ballotOrder") or 0)):
        name, party, inc = clean_candidate(opt.get("name", ""), opt.get("politicalParty"))
        cands.append({"name": name, "party": party, "incumbent": inc,
                      "votes": int(opt.get("voteCount") or 0), "order": i})
    return {
        "id": bi.get("id"),
        "name": (bi.get("name") or "").strip(),
        "vote_for": int(bi.get("voteFor") or 1),
        "ballot_order": bi.get("ballotOrder") or 0,
        "candidates": cands,
        "precincts_reporting": int(bi.get("precinctsReporting") or 0) if with_precincts else None,
        "precincts_total": int(bi.get("precinctsParticipating") or 0) if with_precincts else None,
    }


def _decode(raw: bytes) -> dict:
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            name = next(n for n in z.namelist() if n.lower().endswith(".json"))
            raw = z.read(name)
    return json.loads(raw.decode("utf-8-sig"))


def load(cfg: dict, get) -> dict:
    eid = (cfg.get("election_id") or "").strip()
    if not eid:
        raise RuntimeError("georgia.election_id not set in config/races.yml")
    base = cfg.get("base", "https://results.sos.ga.gov/cdn/results/Georgia").rstrip("/")
    raw = None
    errors = []
    for ext in ("zip", "json"):
        try:
            raw = get(f"{base}/export-{eid}.{ext}")
            break
        except Exception as e:  # zip may not exist for every election; fall back to json
            errors.append(f"{ext}: {e}")
    if raw is None:
        raise RuntimeError("; ".join(errors))
    data = _decode(raw)

    statewide = {}
    for bi in (data.get("results") or {}).get("ballotItems") or []:
        c = _contest(bi, with_precincts=False)
        c["precincts_reporting"], c["precincts_total"] = 0, 0
        statewide[c["id"]] = c

    counties: dict[str, list[dict]] = {}
    local_ids: dict = {}  # contest id -> list of (county, contest) for contests not in statewide
    for county in data.get("localResults") or []:
        cname = (county.get("name") or "").strip()
        items = []
        for bi in county.get("ballotItems") or []:
            c = _contest(bi, with_precincts=True)
            c["county"] = cname
            items.append(c)
            sw = statewide.get(c["id"])
            if sw is not None:
                sw["precincts_reporting"] += c["precincts_reporting"]
                sw["precincts_total"] += c["precincts_total"]
                sw.setdefault("county_results", []).append({
                    "name": cname, "pr": c["precincts_reporting"], "pt": c["precincts_total"],
                    "votes": {cand["name"]: cand["votes"] for cand in c["candidates"]}})
            else:
                local_ids.setdefault(c["id"], []).append(c)
        counties[cname] = items

    for c in statewide.values():
        c["statewide"] = len(c.get("county_results") or []) == len(counties) > 1

    # Local contests that span several counties (e.g. a city in two counties): combined totals.
    multi = {}
    for cid, parts in local_ids.items():
        if len(parts) < 2:
            continue
        merged = {"id": cid, "name": parts[0]["name"], "vote_for": parts[0]["vote_for"],
                  "ballot_order": parts[0]["ballot_order"],
                  "precincts_reporting": sum(p["precincts_reporting"] for p in parts),
                  "precincts_total": sum(p["precincts_total"] for p in parts),
                  "counties": [p["county"] for p in parts], "candidates": []}
        by_name = {}
        for p in parts:
            for cand in p["candidates"]:
                slot = by_name.setdefault(cand["name"], dict(cand, votes=0))
                slot["votes"] += cand["votes"]
        merged["candidates"] = sorted(by_name.values(), key=lambda c: c["order"])
        multi[cid] = merged

    page = cfg.get("page", "https://results.sos.ga.gov/results/public/Georgia/elections/{election_id}")
    return {
        "updated": data.get("createdAt"),
        "election_name": data.get("electionName"),
        "page": page.format(election_id=eid),
        "contests": {c["id"]: c for c in statewide.values()},
        "counties": counties,
        "multi_county": multi,
    }
