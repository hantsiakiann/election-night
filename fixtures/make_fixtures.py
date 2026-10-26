"""Generate fake-but-schema-faithful feeds for offline testing.

    python fixtures/make_fixtures.py [--reporting 0.4] [--election-id TEST]

Georgia follows the SOS "Enhanced Results JSON Media Export" guide; NC follows the
results_pct TSV columns; MN follows the semicolon media-file layout. County names come from
the site's map file so county maps can be tested; candidates and numbers are invented.
Re-run with a different --reporting to simulate the night progressing.
"""
import argparse
import csv
import io
import json
import random
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
METRO = {"Fulton": .30, "DeKalb": .38, "Cobb": .10, "Gwinnett": .14, "Clayton": .42}


def county_names(fips):
    geo = json.loads((ROOT / "site/geo/counties.json").read_text())
    return sorted(g["properties"]["name"] for g in geo["objects"]["counties"]["geometries"] if g["id"].startswith(fips))


GA_STATEWIDE = [
    ("US Senate", [("Candidate Alpha (I) (Dem)", "Dem", .505), ("Candidate Bravo (Rep)", "Rep", .48), ("Candidate Charlie (Lib)", "Lib", .015)]),
    ("Governor", [("Candidate Delta (Dem)", "Dem", .49), ("Candidate Echo (Rep)", "Rep", .495), ("Candidate Foxtrot (Lib)", "Lib", .015)]),
    ("Lieutenant Governor", [("Candidate Golf (Dem)", "Dem", .48), ("Candidate Hotel (Rep)", "Rep", .52)]),
    ("Secretary of State", [("Candidate India (Dem)", "Dem", .47), ("Candidate Juliet (Rep)", "Rep", .53)]),
    ("Attorney General", [("Candidate Kilo (Dem)", "Dem", .485), ("Candidate Lima (Rep)", "Rep", .515)]),
    ("Public Service Commission - District 3", [("Candidate Mike (Dem)", "", .5), ("Candidate November (I) (Rep)", "", .5)]),
    ("Constitutional Amendment 1 - Next Generation 911 Fund", [("Yes", "", .7), ("No", "", .3)]),
]
GA_HOUSE_LEAN = {1: -.12, 2: .04, 3: -.18, 4: .3, 5: .35, 6: .25, 7: -.1, 8: -.2, 9: -.25, 10: -.15, 11: -.15, 12: -.1, 13: .3, 14: -.25}
GA_LEG = [("State Senate - District 40", .05), ("State Senate - District 6", .02), ("State House of Representatives - District 52", 0)]
GA_LOCAL = {
    "Fulton": [("Fulton County Commission - District 4", [("Local Ann (Dem)", "Dem", .6), ("Local Ben (Rep)", "Rep", .4)]),
               ("Fulton County Board of Education - District 2", [("Local Cara", "", .45), ("Local Dev", "", .35), ("Local Eli", "", .2)])],
    "DeKalb": [("DeKalb County Commission - District 3", [("Local Fay (Dem)", "Dem", .9), ("Local Gus (Rep)", "Rep", .1)]),
               ("City of Decatur - Homestead Exemption Referendum", [("Yes", "", .62), ("No", "", .38)])],
    "Cobb": [("Cobb County Commission - District 2", [("Local Hal (Rep)", "Rep", .49), ("Local Ivy (Dem)", "Dem", .51)])],
    "Gwinnett": [("Gwinnett County Board of Commissioners - District 1", [("Local Jo (Dem)", "Dem", .58), ("Local Kai (Rep)", "Rep", .42)])],
    "Clayton": [("Clayton County Board of Education - District 6", [("Local Lu", "", .55), ("Local Max", "", .45)])],
}
GA_MULTI = ("Chattahoochee Hills Special District Referendum", [("Yes", "", .55), ("No", "", .45)], ["Fulton", "Cobb"])
STATE_TOTAL = 4_200_000


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


def _split(opts, lean, total):
    shares = [max(.002, s + (lean if p in ("Dem", "DEM") else -lean if p in ("Rep", "REP") else 0)) for _, p, s in opts]
    t = sum(shares)
    return [int(total * s / t) for s in shares]


def ga(reporting, seed):
    rnd = random.Random(seed)
    names = county_names("13")
    contests = list(GA_STATEWIDE)
    for d in range(1, 15):
        contests.append((f"US House of Representatives - District {d}",
                         [(f"House{d} Dem (Dem)", "Dem", .5), (f"House{d} Rep (Rep)", "Rep", .5)]))
    for name, _ in GA_LEG:
        contests.append((name, [(name.split(" - ")[1] + " Dem (Dem)", "Dem", .5), (name.split(" - ")[1] + " Rep (Rep)", "Rep", .5)]))
    ids = {name: 1000 + i for i, (name, _) in enumerate(contests)}
    sw_votes = {name: [0] * len(opts) for name, opts in contests}
    sw_order = {name: i + 1 for i, (name, _) in enumerate(contests)}
    local_results, next_local = [], 9000
    for idx, cname in enumerate(names):
        metro = METRO.get(cname)
        lean = metro if metro is not None else rnd.uniform(-.35, .15) if rnd.random() > .15 else rnd.uniform(.05, .3)
        district = 5 if cname in ("Fulton", "DeKalb") else 13 if cname == "Clayton" else 6 if cname == "Cobb" else \
            7 if cname == "Gwinnett" else (idx * 7) % 14 + 1
        pcts = rnd.randint(4, 40) if not metro else rnd.randint(140, 380)
        size = (rnd.uniform(.0008, .006) if not metro else .09)
        frac = 0 if rnd.random() > min(1, reporting * 1.6) else min(1, reporting * rnd.uniform(.6, 1.4))
        reported = int(pcts * frac)
        votes = int(STATE_TOTAL * size * frac)
        items, order = [], 0
        on = [n for n, _ in GA_STATEWIDE] + [f"US House of Representatives - District {district}"]
        if metro is not None:
            on += [n for n, _ in GA_LEG if (cname in ("Fulton", "Cobb") and "District 6" in n) or
                   (cname in ("DeKalb", "Gwinnett") and "40" in n) or (cname == "Fulton" and "52" in n)]
        for name, opts in contests:
            if name not in on:
                continue
            order += 1
            l = lean + (GA_HOUSE_LEAN[district] * .5 if "US House" in name else 0)
            vs = _split(opts, l * .9, votes if "State" not in name else int(votes * .3))
            for j, v in enumerate(vs):
                sw_votes[name][j] += v
            items.append(_item(ids[name], name, order, pcts, reported,
                               [_opt(j, o, p, v) for j, ((o, p, _), v) in enumerate(zip(opts, vs))], "state"))
        for lname, lopts in GA_LOCAL.get(cname, []):
            order += 1
            next_local += 1
            items.append(_item(next_local, lname, order, pcts, reported,
                               [_opt(j, o, p, int(votes * .3 * s)) for j, (o, p, s) in enumerate(lopts)], "local"))
        if cname in GA_MULTI[2]:
            order += 1
            items.append(_item(8500, GA_MULTI[0], order, 6, int(6 * frac),
                               [_opt(j, o, p, int(votes * .01 * s)) for j, (o, p, s) in enumerate(GA_MULTI[1])], "local"))
        local_results.append({"id": idx + 1, "name": f"{cname} County", "ballotItems": items,
                              "reportingStatuses": [{"groupName": "Election Day", "status": "Partially Reported"}]})
    results_items = [_item(ids[n], n, sw_order[n], None, None,
                           [_opt(j, o, p, sw_votes[n][j]) for j, (o, p, _) in enumerate(opts)], "state")
                     for n, opts in contests]
    return {"electionDate": "2026-11-03", "electionName": "November 3, 2026 General Election (TEST DATA)",
            "createdAt": "2026-11-04T01:12:33.1234567Z",
            "results": {"id": 0, "name": "Georgia", "ballotItems": results_items, "reportingStatuses": []},
            "localResults": local_results}


def nc(reporting, seed):
    rnd = random.Random(seed + 1)
    cols = ["County", "Election Date", "Precinct", "Contest Group ID", "Contest Type", "Contest Name", "Choice",
            "Choice Party", "Vote For", "Election Day", "Early Voting", "Absentee by Mail", "Provisional",
            "Total Votes", "Real Precinct"]
    senate = [("Candidate Nc-D", "DEM", .5), ("Candidate Nc-R", "REP", .48), ("Candidate Nc-L", "LIB", .02)]
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(cols)
    for i, county in enumerate(county_names("37")):
        lean = rnd.uniform(-.3, .25)
        district = i % 14 + 1
        for p in range(rnd.randint(3, 12)):
            reported = rnd.random() < reporting
            base = int(rnd.uniform(400, 1500)) if reported else 0
            for cname, opts in [("US SENATE", senate),
                                (f"US HOUSE OF REPRESENTATIVES DISTRICT {district:02d}",
                                 [(f"NC{district} Dem", "DEM", .5), (f"NC{district} Rep", "REP", .5)])]:
                for choice, party, v in zip([o[0] for o in opts], [o[1] for o in opts], _split(opts, lean, base)):
                    w.writerow([county.upper(), "11/03/2026", f"P{p:03d}", 1, "S", cname, choice, party, 1,
                                v // 3, v - v // 3, 0, 0, v, "Y"])
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("results_pct_20261103.txt", buf.getvalue())
    return b.getvalue()


def mn(reporting):
    rows, pt = [], 4100
    pr = int(pt * reporting)
    for order, (name, party, share) in enumerate([("Candidate Mn-DFL", "DFL", .53), ("Candidate Mn-R", "R", .44), ("Candidate Mn-LMN", "LMN", .03)]):
        rows.append(["MN", "", "", "0102", "U.S. Senator", "", f"01{order}", name, "", "", party, pr, pt,
                     int(2_900_000 * reporting * share), round(share * 100, 2), int(2_900_000 * reporting)])
    return "\n".join(";".join(str(x) for x in r) for r in rows).encode("latin-1")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reporting", type=float, default=0.45)
    ap.add_argument("--election-id", default="TEST")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    raw = json.dumps(ga(a.reporting, a.seed)).encode()
    gdir = HERE / "georgia"
    gdir.mkdir(exist_ok=True)
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
