"""Print the shape of a JSON feed so you can fill in a json_map source quickly.

    python -m fetcher.probe https://example.gov/results.json
"""
import json
import sys

import requests


def walk(o, path="", depth=0, max_depth=6):
    if depth > max_depth:
        return
    if isinstance(o, dict):
        for k, v in list(o.items())[:40]:
            p = f"{path}.{k}" if path else k
            if isinstance(v, (dict, list)):
                print(f"{p}  <{type(v).__name__} len={len(v)}>")
                walk(v, p, depth + 1)
            else:
                print(f"{p} = {str(v)[:60]!r}")
    elif isinstance(o, list) and o:
        walk(o[0], f"{path}.0", depth + 1)


if __name__ == "__main__":
    r = requests.get(sys.argv[1], timeout=60, headers={"User-Agent": "election-night-probe"})
    r.raise_for_status()
    walk(json.loads(r.content.decode("utf-8-sig")))
