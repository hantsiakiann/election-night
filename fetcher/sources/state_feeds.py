"""Readers for state results feeds verified against each state's zero-vote Nov 3, 2026 files.

Every load(cfg, get) returns {"updated", "page", "contests": {name: contest}} where a contest is
{"id", "name", "vote_for", "precincts_reporting", "precincts_total", "candidates": [{name, party,
votes, order, incumbent}], optional "county_results": [{name, pr, pt, votes: {cand: n}}],
"statewide"} -- the same shape the other adapters produce, so model.finalize handles the rest.

  results_csv  Nebraska, South Dakota, New Mexico (resultsCSV.aspx exports; one URL per office group)
  fl_dos       Florida Division of Elections election-night file (tab-separated, one row per county)
  ca_sos       California Secretary of State media JSON (statewide/district totals plus counties)
  nist1500     Ohio's NIST SP 1500-100 / IEEE 1622 XML (VSSC1622XmlFileBlob)
  la_sos       Louisiana Secretary of State graphical-results JSON blobs
"""
import csv
import io
import json
import re
import xml.etree.ElementTree as ET

from ..model import clean_candidate, norm_party


# ----------------------------------------------------------------------------- helpers
def _space(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace(" ", " ")).strip()


def _name(s: str, ticket: bool = False) -> str:
    """Tidy a candidate label: collapse spaces, fix ALL CAPS; for a governor/lt. governor ticket
    ("Jim Pillen and Joe Kelly") keep only the governor."""
    s = _space(s)
    if ticket:
        s = re.split(r"\s+(?:and|AND|&|/)\s+", s)[0]
    if s.isupper() and len(s) > 3:
        s = " ".join(w if re.fullmatch(r"(I|II|III|IV|JR|SR)\.?", w) else w.capitalize() for w in s.split())
        s = re.sub(r"\b(Jr|Sr)\b", lambda m: m.group(1).capitalize(), s)
    return s


YES_NO = {"yes": "Yes", "no": "No", "for": "Yes", "against": "No"}


def _yes_no(label: str) -> str | None:
    w = _space(label).lower().split(" ")[0] if label else ""
    return YES_NO.get(w)


def _new_contest(name, vote_for=1):
    return {"id": name, "name": name, "vote_for": vote_for, "precincts_reporting": 0,
            "precincts_total": 0, "_cands": {}, "_counties": {}}


def _add(c, key, name, party, votes, county=None, incumbent=False):
    slot = c["_cands"].setdefault(key, {"name": name, "party": party, "votes": 0,
                                        "order": len(c["_cands"]), "incumbent": incumbent})
    slot["votes"] += votes
    if county:
        cr = c["_counties"].setdefault(county, {"name": county, "pr": 0, "pt": 0, "votes": {}})
        cr["votes"][name] = cr["votes"].get(name, 0) + votes


def _finish(contests, statewide_names=()):
    out = {}
    for name, c in contests.items():
        c["candidates"] = list(c.pop("_cands").values())
        counties = list(c.pop("_counties").values())
        if len(counties) > 1:
            c["county_results"] = counties
            c["statewide"] = c.get("statewide", name in statewide_names)
        out[name] = c
    return out


def _int(s) -> int:
    try:
        return int(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0


# ----------------------------------------------------------------------------- NE / SD / NM
def results_csv(cfg: dict, get) -> dict:
    """resultsCSV.aspx exports. Columns include RaceName, AreaNum, PartyCode, CandidateName,
    VoteFor, CandidateVotes, PrecinctsReporting ("12/2204", sometimes wrapped as ="12/2204")."""
    contests, errors, loaded = {}, [], 0
    for url in cfg["urls"]:
        try:
            raw = get(url)
        except Exception as e:  # one office group failing shouldn't drop the rest
            errors.append(f"{url}: {e}")
            continue
        loaded += 1
        for r in csv.DictReader(io.StringIO(raw.decode("utf-8-sig", "replace"))):
            race = _space(r.get("RaceName"))
            if not race:
                continue
            area = _space(r.get("AreaNum"))
            name = f"{race} {area}" if area else race
            c = contests.get(name)
            if c is None:
                c = contests[name] = _new_contest(name, _int(r.get("VoteFor")) or 1)
                m = re.search(r"(\d+)\s*/\s*(\d+)", r.get("PrecinctsReporting") or "")
                if m:
                    c["precincts_reporting"], c["precincts_total"] = int(m.group(1)), int(m.group(2))
            label = r.get("CandidateName") or ""
            yn = _yes_no(label)
            nm = yn or _name(label, ticket="Governor" in race)
            _add(c, r.get("CandidateID") or nm, nm, "" if yn else norm_party(r.get("PartyCode")),
                 _int(r.get("CandidateVotes")))
    if not loaded:
        raise RuntimeError("; ".join(errors))
    return {"updated": None, "page": cfg.get("page"), "contests": _finish(contests)}


# ----------------------------------------------------------------------------- Florida
def fl_dos(cfg: dict, get) -> dict:
    raw = get(cfg["url"]).decode("latin-1")
    contests, seen_units = {}, set()
    for r in csv.DictReader(io.StringIO(raw), delimiter="\t"):
        race = _space(r.get("RaceName"))
        if not race:
            continue
        c = contests.get(race) or contests.setdefault(race, _new_contest(race))
        county = _space(r.get("CountyName"))
        if (race, county) not in seen_units:  # precinct counts repeat on every candidate row
            seen_units.add((race, county))
            pr, pt = _int(r.get("PrecinctsReporting")), _int(r.get("Precincts"))
            c["precincts_reporting"] += pr
            c["precincts_total"] += pt
            cr = c["_counties"].setdefault(county, {"name": county, "pr": 0, "pt": 0, "votes": {}})
            cr["pr"], cr["pt"] = pr, pt
        label = _space(r.get("CanNameLast"))
        yn = _yes_no(label) if r.get("RaceCode") == "AMD" else None
        if (r.get("CanNameMiddle") or "").strip() == "/":  # governor ticket: "Donalds / Avila"
            nm = yn or _space(r.get("CanNameFirst"))
        else:
            nm = yn or _space(f"{r.get('CanNameFirst', '')} {label}")
        party = "" if yn else norm_party(r.get("PartyCode"))
        _add(c, nm, nm, party, _int(r.get("CanVotes")), county)
        if r.get("RaceCode") in ("USS", "GOV", "ATG", "CFO", "AGR", "AMD"):
            c["statewide"] = True
    return {"updated": None, "page": cfg.get("page"), "contests": _finish(contests)}


# ----------------------------------------------------------------------------- California
_CA_TITLE = re.compile(r"^(.*?) - (Statewide|Districtwide|(.+?)(?: County)?) Results$")
_CA_REPORT = re.compile(r"\(([\d,]+) of ([\d,]+)\)")


def ca_sos(cfg: dict, get) -> dict:
    contests, errors, loaded = {}, [], 0
    for url in cfg["urls"]:
        try:
            items = json.loads(get(url).decode("utf-8-sig"))
        except Exception as e:
            errors.append(f"{url}: {e}")
            continue
        loaded += 1
        for it in items:
            m = _CA_TITLE.match(_space(it.get("raceTitle")))
            if not m:
                continue
            base, scope, county = m.group(1), m.group(2), m.group(3)
            rep = _CA_REPORT.search(it.get("Reporting") or "")
            pr, pt = (_int(rep.group(1)), _int(rep.group(2))) if rep else (0, 0)
            if "ballot-measures" in it:  # one item per measure per scope
                for bm in it["ballot-measures"]:
                    name = f"Proposition {int(bm['Number'])}: {_space(bm['Name'])}" if bm.get("Number", "").isdigit() \
                        else _space(bm.get("Name"))
                    _ca_fill(contests, name, scope, county, pr, pt,
                             [("Yes", "", _int(bm.get("yesVotes")), False), ("No", "", _int(bm.get("noVotes")), False)])
                continue
            cands = [(_space(c.get("Name")), norm_party(c.get("Party")), _int(c.get("Votes")), bool(c.get("incumbent")))
                     for c in it.get("candidates") or []]
            _ca_fill(contests, base, scope, county, pr, pt, cands)
    if not loaded:
        raise RuntimeError("; ".join(errors))
    out = {}
    for name, c in contests.items():
        c["candidates"] = list(c.pop("_cands").values())
        counties = list(c.pop("_counties").values())
        if len(counties) > 1:
            c["county_results"], c["statewide"] = counties, c.pop("_statewide", False)
        c.pop("_statewide", None)
        out[name] = c
    return {"updated": None, "page": cfg.get("page"), "contests": out}


def _ca_fill(contests, name, scope, county, pr, pt, cands):
    c = contests.get(name) or contests.setdefault(name, _new_contest(name))
    if county:
        cr = c["_counties"].setdefault(county, {"name": county, "pr": pr, "pt": pt, "votes": {}})
        for nm, _, v, _ in cands:
            cr["votes"][nm] = v
        return
    # statewide / districtwide totals are authoritative for the race itself
    c["precincts_reporting"], c["precincts_total"] = pr, pt
    c["_statewide"] = scope == "Statewide"
    for nm, party, v, inc in cands:
        slot = c["_cands"].setdefault(nm, {"name": nm, "party": party, "votes": 0, "order": len(c["_cands"]),
                                           "incumbent": inc})
        slot["votes"] = v


# ----------------------------------------------------------------------------- Ohio (NIST 1500-100)
def nist1500(cfg: dict, get) -> dict:
    root = ET.fromstring(get(cfg["url"]))
    ns = root.tag[1:].split("}")[0]
    q = lambda t: f"{{{ns}}}{t}"  # noqa: E731
    xt = "{http://www.w3.org/2001/XMLSchema-instance}type"

    def text(el, tag):
        node = el.find(q(tag))
        if node is None:
            return ""
        ls = node.find(q("LanguageString"))
        return _space(ls.text if ls is not None else node.text)

    units = {g.get("ObjectId"): g for g in root.find(q("GpUnitCollection"))}
    parties = {}
    for p in root.find(q("PartyCollection")):
        ab = p.get("Abbreviation") or ""
        parties[p.get("ObjectId")] = "" if ab in ("", "None") else norm_party(ab)
    election = root.find(q("Election"))
    cands = {}
    for c in election.find(q("CandidateCollection")):
        cands[c.get("ObjectId")] = (_name(text(c, "BallotName"), ticket=True), parties.get(c.findtext(q("PartyId")) or "", ""))

    contests = {}
    for ct in election.find(q("ContestCollection")):
        name = _space(ct.get("Name"))
        c = contests[name] = _new_contest(name, _int(ct.get("VotesAllowed")) or 1)
        district = units.get(ct.findtext(q("ElectoralDistrictId")) or ct.findtext(q("JurisdictionalScopeId")) or "")
        if district is not None:
            c["precincts_reporting"] = _int(district.get("SubUnitsReported"))
            c["precincts_total"] = _int(district.get("TotalSubUnits"))
            c["statewide"] = district.get("Type") == "State"
        for i, sel in enumerate(ct.findall(q("BallotSelection"))):
            if sel.get("IsWriteIn") == "true":
                continue
            if sel.get(xt) == "BallotMeasureSelection":
                nm, party = YES_NO.get((sel.get("Selection") or "").lower(), _space(sel.get("Selection"))), ""
            else:
                ids = (sel.findtext(q("CandidateId")) or sel.findtext(q("CandidateIds")) or "").split()
                nm, party = cands.get(ids[0] if ids else "", (f"Candidate {i + 1}", ""))
            for vc in (sel.find(q("VoteCountsCollection")) or []):
                if vc.get("Type") != "Total":
                    continue
                unit = units.get(vc.findtext(q("GpUnitId")) or "")
                if unit is None or unit.get("Type") != "County":
                    continue
                county = _space(unit.get("Name"))
                _add(c, nm, nm, party, _int(vc.get("Count")), county)
                cr = c["_counties"][county]
                cr["pr"], cr["pt"] = _int(unit.get("SubUnitsReported")), _int(unit.get("TotalSubUnits"))
            c["_cands"].setdefault(nm, {"name": nm, "party": party, "votes": 0, "order": len(c["_cands"]),
                                        "incumbent": False})
    for c in contests.values():  # no district-level precinct counts: fall back to the counties
        if not c["precincts_total"] and c["_counties"]:
            c["precincts_reporting"] = sum(cr["pr"] for cr in c["_counties"].values())
            c["precincts_total"] = sum(cr["pt"] for cr in c["_counties"].values())
    test = root.get("IsTest") == "true"
    if test:  # Ohio's pre-election test file may carry made-up numbers: keep the ballot, drop the votes
        for c in contests.values():
            for slot in c["_cands"].values():
                slot["votes"] = 0
            for cr in c["_counties"].values():
                cr["votes"] = {k: 0 for k in cr["votes"]}
                cr["pr"] = 0
            c["precincts_reporting"] = 0
    return {"updated": root.get("GeneratedDate"), "page": cfg.get("page"), "contests": _finish(contests),
            "is_test": test}


# ----------------------------------------------------------------------------- Louisiana
def la_sos(cfg: dict, get) -> dict:
    base = cfg["base"]  # .../Data?blob=20261103/
    info = json.loads(get(base + "RacesCandidates_Multiparish.htm").decode("utf-8-sig"))
    votes = json.loads(get(base + "Votes_Multiparish.htm").decode("utf-8-sig"))
    totals = {r["ID"]: r for r in (votes.get("Races") or {}).get("Race") or []}
    contests = {}
    for r in (info.get("Races") or {}).get("Race") or []:
        name = _space(r.get("SpecificTitle"))
        c = contests[name] = _new_contest(name, _int(r.get("NumberToBeElected")) or 1)
        t = totals.get(r["ID"]) or {}
        c["precincts_reporting"], c["precincts_total"] = _int(t.get("PrecinctsReporting")), _int(t.get("PrecinctsExpected"))
        got = {ch["ID"]: _int(ch.get("VoteTotal")) for ch in t.get("Choice") or []}
        for ch in r.get("Choice") or []:
            label = _space(ch.get("Desc")).replace('"', "")
            yn = _yes_no(label)
            m = re.search(r"\s*\(([A-Z]+)\)$", label)  # "Julia Letlow (REP)", "E. Liddy Glass (NOPTY)"
            if yn:
                nm, party, inc = yn, "", False
            elif m:
                nm, party, inc = label[: m.start()], ("" if m.group(1) in ("NOPTY", "NP") else norm_party(m.group(1))), False
            else:
                nm, party, inc = clean_candidate(label, None)
            _add(c, ch["ID"], _name(nm), party, got.get(ch["ID"], 0), incumbent=inc)
    return {"updated": (votes.get("Races") or {}).get("VersionDateTime"), "page": cfg.get("page"),
            "contests": _finish(contests)}
