"""Fetch every configured source, normalize, and write one results.json for the page.

    python -m fetcher.run                       # live
    python -m fetcher.run --fixtures fixtures   # offline test data
    python -m fetcher.run --list-contests       # print contest names each source publishes
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

from .model import finalize
from .sources import enhanced_voting, json_map, mn_sos, ncsbe

ADAPTERS = {"enhanced_voting": enhanced_voting.load, "ncsbe": ncsbe.load,
            "mn_sos": mn_sos.load, "json_map": json_map.load}
UA = "election-night-tracker (watch party; github.com/hantsiakiann)"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def make_getter(fixtures: Path | None, source: str):
    if fixtures:
        folder = fixtures / source

        def get(url: str) -> bytes:
            name = url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
            p = folder / name
            if not p.exists():
                raise FileNotFoundError(f"fixture {p}")
            return p.read_bytes()
        return get

    session = requests.Session()
    session.headers["User-Agent"] = UA

    def get(url: str) -> bytes:
        last = None
        for attempt in range(3):
            try:
                r = session.get(url, timeout=90)
                r.raise_for_status()
                return r.content
            except requests.RequestException as e:
                last = e
                if getattr(e, "response", None) is not None and e.response.status_code == 404:
                    break
                time.sleep(3 * (attempt + 1))
        raise RuntimeError(f"{url}: {last}")
    return get


def find_contest(contests: dict, pattern: str) -> dict | None:
    rx = re.compile(pattern, re.I)
    for c in sorted(contests.values(), key=lambda c: c.get("ballot_order") or 0):
        if rx.search(c["name"]):
            return c
    return None


# --------------------------------------------------------------------------- tabs
def build_national(cfg, loaded):
    out = {}
    for group, races in (cfg.get("national") or {}).items():
        rows = []
        for r in races:
            src = r.get("source", "manual")
            base = {"id": r["id"], "title": r.get("title", r["id"]), "group": group,
                    "link": r.get("link"), "note": r.get("note")}
            data = loaded.get(src)
            contest = find_contest(data["contests"], r["contest"]) if data and r.get("contest") else None
            if contest:
                race = finalize(contest, race_id=r["id"], title=base["title"], source=src,
                                source_url=r.get("link") or data.get("page"), updated=data.get("updated"),
                                majority_rule=bool(r.get("majority_rule", src == "georgia")))
                race.update({k: v for k, v in base.items() if v and k not in ("title", "id")})
            else:
                race = dict(base, candidates=[], source=src, source_url=r.get("link"),
                            status="no-feed" if src == "manual" else ("source-error" if src not in loaded
                                                                     else "not-found"))
                if src != "manual" and src in loaded:
                    race["note"] = race.get("note") or f"No contest matching /{r['contest']}/ in {src} feed yet"
            rows.append(race)
        out[group] = rows
    return out


def build_georgia(cfg, ga):
    gcfg = cfg.get("georgia") or {}
    sections = [dict(name=s["name"], collapsed=bool(s.get("collapsed")), races=[], _rx=re.compile(s["match"], re.I))
                for s in gcfg.get("sections", [{"name": "All", "match": ".*"}])]
    majority = bool(gcfg.get("majority_rule", True))
    for c in sorted(ga["contests"].values(), key=lambda c: c.get("ballot_order") or 0):
        race = finalize(c, race_id=f"GA-{c['id']}", source="georgia", source_url=ga["page"],
                        updated=ga["updated"], majority_rule=majority)
        for s in sections:
            if s["_rx"].search(c["name"]):
                s["races"].append(race)
                break
    for s in sections:
        del s["_rx"]
    return {"page": ga["page"], "election_name": ga.get("election_name"),
            "sections": [s for s in sections if s["races"]]}


def build_metro(cfg, ga):
    gcfg, mcfg = cfg.get("georgia") or {}, cfg.get("metro") or {}
    top_rx = re.compile(gcfg.get("county_top_of_ticket", "^Governor$"), re.I)
    leg_rx = re.compile(r"^State (Senat|House|Rep)", re.I)
    statewide = ga["contests"]
    counties = []
    for want in mcfg.get("counties", []):
        key = next((k for k in ga["counties"] if k.lower().startswith(want.lower())), None)
        if key is None:
            counties.append({"name": want, "missing": True, "top": [], "sections": []})
            continue
        top, local, multi, leg = [], [], [], []
        slug = re.sub(r"[^a-z]", "", want.lower())
        for c in sorted(ga["counties"][key], key=lambda c: c.get("ballot_order") or 0):
            if c["id"] in statewide:
                sw = statewide[c["id"]]
                if top_rx.search(c["name"]):
                    top.append(finalize(c, race_id=f"GA-{c['id']}-{slug}", source="georgia",
                                        source_url=ga["page"], updated=ga["updated"],
                                        extra={"scope": f"{want} County only"}))
                elif leg_rx.search(c["name"]):
                    leg.append(finalize(sw, race_id=f"GA-{c['id']}", source="georgia", source_url=ga["page"],
                                        updated=ga["updated"], majority_rule=True,
                                        extra={"scope": "district-wide"}))
            elif c["id"] in ga.get("multi_county", {}):
                m = ga["multi_county"][c["id"]]
                multi.append(finalize(m, race_id=f"GA-{c['id']}", source="georgia", source_url=ga["page"],
                                      updated=ga["updated"], majority_rule=True,
                                      extra={"scope": "spans " + ", ".join(m["counties"])}))
            else:
                local.append(finalize(c, race_id=f"GA-{c['id']}-{slug}", source="georgia",
                                      source_url=ga["page"], updated=ga["updated"], majority_rule=True))
        sections = [s for s in (
            {"name": f"{want} County & cities", "collapsed": False, "races": local},
            {"name": "Multi-county local races", "collapsed": False, "races": multi},
            {"name": "Legislature (districts touching the county)", "collapsed": True, "races": leg},
        ) if s["races"]]
        counties.append({"name": want, "feed_name": key, "top": top, "sections": sections})
    return {"page": ga["page"], "counties": counties}


# --------------------------------------------------------------------------- merge
def iter_races(results):
    for group in (results.get("national") or {}).values():
        yield from group
    for s in (results.get("georgia") or {}).get("sections", []):
        yield from s["races"]
    for c in (results.get("metro") or {}).get("counties", []):
        yield from c.get("top", [])
        for s in c.get("sections", []):
            yield from s["races"]


def apply_manual(results, manual):
    entries = (manual or {}).get("races") or {}
    if not entries:
        return
    for race in iter_races(results):
        m = entries.get(race["id"]) or entries.get(race.get("feed_name") or "") or entries.get(race.get("title") or "")
        if not m:
            continue
        for k in ("call", "called_by", "note"):
            if m.get(k):
                race[k] = m[k]
        if m.get("candidates") and (race.get("status") in ("no-feed", "not-found", "source-error", "empty")
                                    or m.get("override")):
            contest = {"name": race.get("feed_name") or race["title"],
                       "candidates": [{"name": c["name"], "party": c.get("party", ""),
                                       "votes": int(c.get("votes") or 0), "incumbent": bool(c.get("incumbent"))}
                                      for c in m["candidates"]],
                       "reporting_pct": m.get("reporting_pct")}
            keep = {k: race[k] for k in ("id", "title", "group", "link", "note", "call", "called_by", "scope") if race.get(k)}
            race.clear()
            race.update(finalize(contest, race_id=keep["id"], title=keep.get("title"), source="manual",
                                 source_url=keep.get("link"), updated=m.get("updated")))
            race.update(keep)
            race["status"] = "manual"


def carry_forward(results, previous, failed_sources):
    """Reuse the last good numbers for races whose source failed this run."""
    if not previous or not failed_sources:
        return
    prev = {r["id"]: r for r in iter_races(previous)}
    for group in (results.get("national") or {}).values():
        for i, race in enumerate(group):
            p = prev.get(race["id"])
            if race.get("source") in failed_sources and p and p.get("candidates"):
                group[i] = dict(p, stale=True, status="stale")
    if "georgia" in failed_sources:
        for key in ("georgia", "metro"):
            if previous.get(key) and not results.get(key):
                results[key] = copy.deepcopy(previous[key])
                for race in iter_races({key: results[key]}):
                    race["stale"], race["status"] = True, "stale"


def load_previous(arg, site_url):
    try:
        if arg and os.path.exists(arg):
            return json.loads(Path(arg).read_text())
        url = arg or (site_url.rstrip("/") + "/data/results.json" if site_url else None)
        if url:
            r = requests.get(url, params={"t": int(time.time())}, timeout=20, headers={"User-Agent": UA})
            if r.ok:
                return r.json()
    except Exception as e:  # first run, or site not up yet
        print(f"[previous] none: {e}", file=sys.stderr)
    return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config/races.yml")
    ap.add_argument("--manual", default="config/manual.yml")
    ap.add_argument("--out", default="_site/data/results.json")
    ap.add_argument("--fixtures", type=Path)
    ap.add_argument("--previous", help="path or URL of last results.json (default: site_url)")
    ap.add_argument("--list-contests", action="store_true")
    args = ap.parse_args(argv)

    cfg = yaml.safe_load(Path(args.config).read_text())
    manual = yaml.safe_load(Path(args.manual).read_text()) if Path(args.manual).exists() else {}

    loaded, status = {}, {}
    for name, scfg in (cfg.get("sources") or {}).items():
        t0 = time.time()
        try:
            loaded[name] = ADAPTERS[scfg["type"]](scfg, make_getter(args.fixtures, name))
            status[name] = {"ok": True, "updated": loaded[name].get("updated"),
                            "contests": len(loaded[name]["contests"]), "page": loaded[name].get("page"),
                            "seconds": round(time.time() - t0, 1)}
        except Exception as e:
            status[name] = {"ok": False, "error": str(e)[:300], "page": scfg.get("page")}
        print(f"[{name}] {'ok' if status[name]['ok'] else 'FAILED'} {status[name]}", file=sys.stderr)

    if args.list_contests:
        for name, data in loaded.items():
            print(f"\n== {name} ({len(data['contests'])} contests)")
            for c in sorted(data["contests"].values(), key=lambda c: c.get("ballot_order") or 0):
                print("  ", c["name"])
            for county, items in (data.get("counties") or {}).items():
                if any(county.lower().startswith(w.lower()) for w in (cfg.get("metro") or {}).get("counties", [])):
                    print(f"  -- {county}: {len(items)} contests")
                    for c in items:
                        print("     ", c["name"])
        return 0

    results = {
        "title": cfg.get("title", "Election Night"),
        "election_date": cfg.get("election_date"),
        "generated_at": now_iso(),
        "refresh_seconds": cfg.get("refresh_seconds", 60),
        "sources": status,
        "national": build_national(cfg, loaded),
        "georgia": build_georgia(cfg, loaded["georgia"]) if "georgia" in loaded else None,
        "metro": build_metro(cfg, loaded["georgia"]) if "georgia" in loaded else None,
    }
    failed = {n for n, s in status.items() if not s["ok"]}
    carry_forward(results, load_previous(args.previous, None if args.fixtures else cfg.get("site_url")), failed)
    apply_manual(results, manual)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(results, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(out)
    n = sum(1 for _ in iter_races(results))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {n} races)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
