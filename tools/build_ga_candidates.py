"""Build config/ga_candidates.yml: Georgia's Nov 3 statewide, State Senate and State House
candidates, used as placeholders on the Georgia tab until the Secretary of State's results feed
is live.

    python tools/build_ga_candidates.py                       # fetch from branch.vote (GitHub Actions)
    python tools/build_ga_candidates.py --from-json races.json  # saved list of Branch race objects

Candidates come from Branch (branch.vote), a nonpartisan Georgia voter guide whose race pages
embed the race list as JSON. Constitutional amendments are listed by hand below (SOS summaries).
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

import yaml

URL = "https://www.branch.vote/elections/state/ga/2026-georgia-general-election/races?racesPage={}"
STATEWIDE = {  # Branch office -> title used on the site (matches config/races.yml section patterns)
    "ga-state-us-senator": "US Senate",
    "ga-state-governor": "Governor",
    "ga-state-lt-governor": "Lieutenant Governor",
    "ga-state-secretary-state": "Secretary of State",
    "ga-state-attorney-general": "Attorney General",
    "ga-state-ag-commissioner": "Commissioner of Agriculture",
    "ga-state-insurance-commissioner": "Commissioner of Insurance",
    "ga-state-state-superintendent": "State School Superintendent",
    "ga-state-labor-commissioner": "Commissioner of Labor",
    "ga-state-public-service-commissioner": "Public Service Commission",
}
AMENDMENTS = [
    ("Amendment 1", "Conservation use property: raise the acreage cap",
     "Raises the most land one owner can enroll in the conservation-use property tax program from 2,000 to 4,000 acres."),
    ("Amendment 2", "Nonpartisan probate judge elections",
     "Requires probate judges to be elected in nonpartisan elections."),
    ("Amendment 3", "Next Generation 9-1-1 Fund",
     "Lets the General Assembly create a dedicated, nonlapsing fund for 9-1-1 systems from existing revenues such as the wireless 911 fee."),
]


METRO = ["Fulton", "DeKalb", "Cobb", "Gwinnett", "Clayton"]
CITY_COUNTY = {"Doraville": "DeKalb", "Brookhaven": "DeKalb", "Pine Lake": "DeKalb", "Stonecrest": "DeKalb"}
METRO_MEASURES = {  # county referendums on the Nov 3 ballot (county election notices / news)
    "Fulton": [
        ("Education SPLOST", "1% sales tax for Fulton County Schools and Atlanta Public Schools",
         "Renews the 1% education sales tax from July 2027 for up to five years (up to $2.1 billion for Fulton County Schools and APS) and approves up to $350 million in APS bonds."),
        ("Transportation SPLOST", "0.75% sales tax for roads outside Atlanta",
         "Adds a 0.75% sales tax in Fulton County outside the City of Atlanta for transportation projects, April 2027 through March 2032."),
    ],
    "Cobb": [
        ("SPLOST", "Renew the 1% county sales tax (2028)",
         "Renews Cobb's 1-cent sales tax starting in 2028 (about $1.15 billion) for a new state court building, fire stations, parks, libraries, roads and sidewalks."),
    ],
    "Gwinnett": [
        ("School homestead exemption (HB 540)", "Expand the extra $2,000 school-tax homestead exemption",
         "Extends the additional $2,000 homestead exemption from school taxes to disabled veterans and all Gwinnett and Buford school district employees."),
    ],
}


# Hand corrections to Branch's data, keyed by race title.
FIXES = {
    "Fulton County Commissioner, District 4": {
        "parties": {"Karen Rene": "I", "Natalie Hall": "I"},
        "note": "Special election to replace Mo Ivory, who resigned.",
    },
}


def metro_section(title):
    t = title.lower()
    if "commission" in t:
        return "County Commission"
    if "board of education" in t:
        return "Board of Education"
    if "city council" in t or "mayor" in t:
        return "Cities"
    return "Other county offices"


def fetch_all():
    races, page, total = {}, 1, None
    while True:
        req = urllib.request.Request(URL.format(page), headers={"User-Agent": "Mozilla/5.0 (election-night tracker)"})
        html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
        props = json.loads(m.group(1))["props"]["pageProps"]
        total = total or props.get("racesTotal") or 0
        for r in props["races"]:
            races[r["raceKey"]] = r
        if not props["races"] or page * 10 >= total + 20:
            break
        page += 1
    return list(races.values())


ORDER = ["County Commission", "Board of Education", "Other county offices", "Cities"]


def natural(s):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-json", type=Path)
    ap.add_argument("--out", default="config/ga_candidates.yml")
    a = ap.parse_args(argv)
    raw = json.loads(a.from_json.read_text()) if a.from_json else fetch_all()

    def cands(r):  # Branch marks nonpartisan candidates "N" (sometimes "/")
        fix = FIXES.get((r.get("longName") or "").strip(), {}).get("parties", {})
        return [{"name": c["name"].strip(),
                 "party": fix.get(c["name"].strip()) or (c.get("party") if c.get("party") in ("D", "R", "I", "L", "G") else "")}
                for c in r.get("candidates") or []]

    statewide, senate, house = [], {}, {}
    metro = {c: {} for c in METRO}
    for r in sorted(raw, key=lambda r: r.get("ballotOrder") or 0):
        office = r.get("office")
        if office in STATEWIDE:
            title = STATEWIDE[office]
            if office == "ga-state-public-service-commissioner":
                n = re.search(r"(\d+)", r.get("longName") or "")
                title = f"Public Service Commission, District {n.group(1)}" if n else title
            statewide.append({"title": title, "candidates": cands(r)})
        elif office == "ga-state-state-senator":
            senate[r["district"]["number"]] = cands(r)
        elif office == "ga-state-state-representative":
            house[r["district"]["number"]] = cands(r)
        else:
            title = (r.get("longName") or "").strip()
            county = next((c for c in METRO if title.startswith(c + " ")), None) \
                or next((cc for city, cc in CITY_COUNTY.items() if title.startswith(city + " ")), None)
            if county:
                if not r.get("candidates"):
                    continue
                item = {"title": title, "candidates": cands(r), "vote_for": r.get("maxChoices") or 1}
                if all(c.get("party") in ("N", "/", "", None) for c in r["candidates"]):
                    item["nonpartisan"] = True
                if (r.get("positionData") or {}).get("special"):
                    item["special"] = True
                if FIXES.get(title, {}).get("note"):
                    item["note"] = FIXES[title]["note"]
                metro[county].setdefault(metro_section(title), []).append(item)

    doc = {
        "_note": "Generated by tools/build_ga_candidates.py from branch.vote. Placeholders only; the SOS feed replaces them.",
        "statewide": statewide,
        "amendments": [{"title": t, "subtitle": s, "yes_means": y} for t, s, y in AMENDMENTS],
        "state_senate": {n: senate[n] for n in sorted(senate)},
        "state_house": {n: house[n] for n in sorted(house)},
        "metro": {c: {"sections": {k: sorted(v, key=lambda x: natural(x["title"])) for k, v in sorted(
                      metro[c].items(), key=lambda kv: ORDER.index(kv[0]))},
                      "measures": [{"title": t, "subtitle": s, "yes_means": y} for t, s, y in METRO_MEASURES.get(c, [])]}
                  for c in METRO},
    }
    Path(a.out).write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=200))
    print(f"wrote {a.out}: {len(statewide)} statewide, {len(senate)} senate, {len(house)} house")
    missing = [f"senate {n}" for n in range(1, 57) if n not in senate] + [f"house {n}" for n in range(1, 181) if n not in house]
    if missing:
        print("!! missing:", ", ".join(missing), file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
