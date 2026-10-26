#!/usr/bin/env bash
# Offline test: fake feeds -> results.json -> local site at http://localhost:8000
#   bash fixtures/test.sh [reporting fraction, default 0.45]
set -euo pipefail
cd "$(dirname "$0")/.."
python3 fixtures/make_fixtures.py --reporting "${1:-0.45}"
python3 - <<'EOF'
import yaml, pathlib
c = yaml.safe_load(pathlib.Path("config/races.yml").read_text())
c["sources"]["georgia"]["election_id"] = "TEST"
pathlib.Path("fixtures/races-test.yml").write_text(yaml.safe_dump(c, sort_keys=False))
EOF
mkdir -p _site && cp -r site/. _site/
python3 -m fetcher.run --config fixtures/races-test.yml --manual fixtures/manual-test.yml \
  --fixtures fixtures --out _site/data/results.json
echo "Serving test data at http://localhost:8000  (Ctrl+C to stop)"
cd _site && python3 -m http.server 8000
