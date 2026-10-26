"""Generate fake-but-schema-faithful feeds for offline testing.

    python fixtures/make_fixtures.py [--reporting 0.4] [--election-id TEST]

Georgia follows the SOS "Enhanced Results JSON Media Export" guide; NC follows the
results_pct TSV columns; MN follows the semicolon media-file layout. Names and numbers
are invented. Re-run with a different --reporting to simulate the night progressing.
"""
import argparse
import csv
import io
import json
import random
import zipfile
from pathlib import Path

HERE = Path(__file__).parent

GA_STATEWIDE = [
    ("US Senate", [("Candidate Alpha (I) (Dem)", "Dem", .51), ("Candidate Bravo (Rep)", "Rep", .47), ("Candidate Charlie (Lib)", "Lib", .02)]),
    ("Governor", [("Candidate Delta (Dem)", "Dem", .49), ("Candidate Echo (Rep)", "Rep", .495), ("Candidate Foxtrot (Lib)", "Lib", .015)]),
    ("Lieutenant Governor", [("Candidate Golf (Dem)", "Dem", .48), ("Candidate Hotel (Rep)", "Rep", .52)]),
    ("Secretary of State", [("Candidate India (Dem)", "Dem", .47), ("Candidate Juliet (Rep)", "Rep", .53)]),
    ("Attorney General", [("Candidate Kilo (Dem)", "Dem", .485), ("Candidate Lima (Rep)", "Rep", .515)]),
    ("Public Service Commission - District 3", [("Candidate Mike (Dem)", "", .5), ("Candidate November (I) (Rep)", "", .5)]),
    ("Constitutional Amendment 1 - Next Generation 911 Fund", [("Yes", "", .7), ("No", "", .3)]),
    ("US House of Representatives - District 5", [("Candidate Oscar (I) (Dem)", "Dem", .82), ("Candidate Papa (Rep)", "Rep", .18)]),
    ("US House of Representatives - District 6", [("Candidate Quebec (I) (Dem)", "Dem", .7), ("Candidate Romeo (Rep)", "Rep", .3)]),
    ("US House of Representatives - District 7", [("Candidate Sierra (I) (Rep)", "Rep", .62), ("Candidate Tango (Dem)", "Dem", .38)]),
    ("US House of Representatives - District 13", [("Candidate Uniform (I) (Dem)", "Dem", .76), ("Candidate Victor (Rep)", "Rep", .24)]),
    ("State Senate - District 40", [("Candidate Whiskey (Dem)", "Dem", .55), ("Candidate Xray (Rep)", "Rep", .45)]),
    ("State Senate - District 6", [("Candidate Yankee (Dem)", "Dem", .52), ("Candidate Zulu (Rep)", "Rep", .48)]),
    ("State House of Representatives - District 52", [("Candidate Able (Dem)", "Dem", .5), ("Candidate Baker (Rep)", "Rep", .5)]),
]
# county -> (precincts, share of state vote, D lean, statewide contests on ballot)
GA_COUNTIES = {
    "Fulton County": (380, .12, .22, {"US House of Representatives - District 5", "US House of Representatives - District 6", "US House of Representatives - District 13", "State Senate - District 6", "State House of Representatives - District 52"}),
    "DeKalb County": (190, .08, .3, {"US House of Representatives - District 5", "US House of Representatives - District 13", "State Senate - District 40"}),
    "Cobb County": (145, .08, .06, {"US House of Representatives - District 6", "State Senate - District 6"}),
    "Gwinnett County": (157, .09, .1, {"US House of Representatives - District 7", "US House of Representatives - District 13", "State Senate - District 40"}),
    "Clayton County": (64, .025, .35, {"US House of Representatives - District 13"}),
    "Chatham County": (90, .03, .1, set()),
    "Cherokee County": (45, .03, -.25, {"US House of Representatives - District 6"}),
}
GA_LOCAL = {
    "Fulton County": [("Fulton County Commission - District 4", [("Local Ann (Dem)", "Dem", .6), ("Local Ben (Rep)", "Rep", .4)]),
                      ("Fulton County Board of Education - District 2", [("Local Cara", "", .45), ("Local Dev", "", .35), ("Local Eli", "", .2)])],
    "DeKalb County": [("DeKalb County Commission - District 3", [("Local Fay (Dem)", "Dem", .9), ("Local Gus (Rep)", "Rep", .1)]),
                      ("City of Decatur - Homestead Exemption Referendum", [("Yes", "", .62), ("No", "", .38)])],
    "Cobb County": [("Cobb County Commission - District 2", [("Local Hal (Rep)", "Rep", .49), ("Local Ivy (Dem)", "Dem", .51)])],
    "Gwinnett County": [("Gwinnett County Board of Commissioners - District 1", [("Local Jo (Dem)", "Dem", .58), ("Local Kai (Rep)", "Rep", .42)])],
    "Clayton County": [("Clayton County Board of Education - District 6", [("Local Lu", "", .55), ("Local Max", "", .45)])],
}
# A local contest that crosses county lines (same id in two counties): appears only under localResults.
GA_MULTI = ("Chattahoochee Hills Special District Referendum", [("Yes", "", .55), ("No", "", .45)], ["Fulton County", "Cobb County"])
STATE_TOTAL = 4_200_000


def ga(reporting: float, eid: str, seed: int):
    rnd = random.Random(seed)
    ids = {name: 1000 + i for i, (name, _) in enumerate(GA_STATEWIDE)}
    statewide_votes = {name: [0] * len(opts) for name, opts in GA_STATEWIDE}
    local_results = []
    next_local = 9000
    multi_id = 8500
    for cname, (pcts, share, lean, on_ballot) in GA_COUNTIES.items():
        reported = int(pcts * min(1, reporting * rnd.uniform(.7, 1.3)))
        frac = reported / pcts
        county_votes = int(STATE_TOTAL * share * frac)
        items = []
        order = 0
        for name, opts in GA_STATEWIDE:
            district = "District" in name and not name.startswith("Public Service")
            if district and name not in on_ballot:
                continue
            order += 1
            vc = county_votes if not district else int(county_votes * .35)
            shares = [max(.001, s + (lean if p == "Dem" else -lean if p == "Rep" else 0) * .5) for _, p, s in opts]
            tot = sum(shares)
            options = []
            for j, ((oname, party, _), s) in enumerate(zip(opts, shares)):
                v = int(vc * s / tot)
                statewide_votes[name][j] += v
                options.append(_opt(j, oname, party, v))
            items.append(_item(ids[name], name, order, pcts if not district else pcts // 3,
                               reported if not district else reported // 3, options, "state"))
        for lname, lopts in GA_LOCAL.get(cname, []):
            order += 1
            next_local += 1
            items.append(_item(next_local, lname, order, pcts, reported,
                               [_opt(j, o, p, int(county_votes * .3 * s)) for j, (o, p, s) in enumerate(lopts)], "local"))
        if cname in GA_MULTI[2]:
            order += 1
            items.append(_item(multi_id, GA_MULTI[0], order, 6, int(6 * frac),
                               [_opt(j, o, p, int(county_votes * .01 * s)) for j, (o, p, s) in enumerate(GA_MULTI[1])], "local"))
        local_results.append({"id": len(local_results) + 1, "name": cname, "ballotItems": items,
                              "reportingStatuses": [{"groupName": "Election Day", "status": "Partially Reported"}]})
    results_items = []
    for i, (name, opts) in enumerate(GA_STATEWIDE):
        results_items.append(_item(ids[name], name, i + 1, None, None,
                                   [_opt(j, o, p, statewide_votes[name][j]) for j, (o, p, _) in enumerate(opts)], "state"))
    return {"electionDate": "2026-11-03", "electionName": "November 3, 2026 General Election (TEST DATA)",
            "createdAt": "2026-11-04T01:12:33.1234567Z",
            "results": {"id": 0, "name": "Georgia", "ballotItems": results_items, "reportingStatuses": []},
            "localResults": local_results}


def _opt(j, name, party, votes):
    return {"id": j + 1, "name": name, "ballotOrder": j + 1, "voteCount": votes, "politicalParty": party,
            "groupResults": [{"groupName": "Advance in Person", "voteCount": int(votes * .6)},
                             {"groupName": "Election Day", "voteCount": votes - int(votes * .6) - int(votes * .05)},
                             {"groupName": "Absentee by Mail", "voteCount": int(votes * .05)}],
            "precinctResults": None}


def _item(i, name, order, pp, pr, options, typ):
    return {"type": typ, "id": i, "name": name, "voteFor": 1, "ballotOrder": order,
            "precinctsParticipating": pp, "precinctsReporting": pr, "contestType": "Candidate",
            "ballotOptions": options, "rankChoiceResults": None}


def nc(reporting: float, seed: int):
    rnd = random.Random(seed)
    cols = ["County", "Election Date", "Precinct", "Contest Group ID", "Contest Type", "Contest Name", "Choice",
            "Choice Party", "Vote For", "Election Day", "Early Voting", "Absentee by Mail", "Provisional",
            "Total Votes", "Real Precinct"]
    contests = [("US SENATE", [("Candidate Nc-D", "DEM", .51), ("Candidate Nc-R", "REP", .47), ("Candidate Nc-L", "LIB", .02)]),
                ("US HOUSE OF REPRESENTATIVES DISTRICT 01", [("Candidate One-D", "DEM", .5), ("Candidate One-R", "REP", .5)]),
                ("US HOUSE OF REPRESENTATIVES DISTRICT 11", [("Candidate Eleven-R", "REP", .54), ("Candidate Eleven-D", "DEM", .46)])]
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(cols)
    for county in ("WAKE", "MECKLENBURG", "PITT", "BUNCOMBE"):
        for p in range(40):
            reported = rnd.random() < reporting
            for cname, opts in contests:
                for choice, party, s in opts:
                    v = int(rnd.uniform(300, 900) * s) if reported else 0
                    w.writerow([county, "11/03/2026", f"P{p:03d}", 1, "S", cname, choice, party, 1, v // 3, v - v // 3, 0, 0, v, "Y"])
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("results_pct_20261103.txt", buf.getvalue())
    return b.getvalue()


def mn(reporting: float):
    rows = []
    pt = 4100
    pr = int(pt * reporting)
    for order, (name, party, share) in enumerate([("Candidate Mn-DFL", "DFL", .53), ("Candidate Mn-R", "R", .44), ("Candidate Mn-LMN", "LMN", .03)]):
        v = int(2_900_000 * reporting * share)
        rows.append(["MN", "", "", "0102", "U.S. Senator", "", f"01{order}", name, "", "", party, pr, pt, v, round(share * 100, 2), int(2_900_000 * reporting)])
    return "\n".join(";".join(str(x) for x in r) for r in rows).encode("latin-1")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reporting", type=float, default=0.45)
    ap.add_argument("--election-id", default="TEST")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    data = ga(a.reporting, a.election_id, a.seed)
    gdir = HERE / "georgia"
    gdir.mkdir(exist_ok=True)
    raw = json.dumps(data).encode()
    (gdir / f"export-{a.election_id}.json").write_bytes(raw)
    with zipfile.ZipFile(gdir / f"export-{a.election_id}.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"export-{a.election_id}.json", raw)
    (HERE / "nc").mkdir(exist_ok=True)
    (HERE / "nc" / "results_pct_20261103.zip").write_bytes(nc(a.reporting, a.seed))
    (HERE / "mn").mkdir(exist_ok=True)
    (HERE / "mn" / "ussenate.txt").write_bytes(mn(a.reporting))
    for f in ("ushouse.txt", "stateoffice.txt"):
        (HERE / "mn" / f).write_bytes(b"")
    print(f"fixtures written at reporting={a.reporting}")
