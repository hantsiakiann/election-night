# Election Night 2026 tracker

Live returns for a watch party, in three tabs: **National** (all 35 Senate, 36 governor
and 435 House races, each with a map and a seat-control bar), **Georgia** (every statewide and legislative contest), and **Metro Atlanta**
(Fulton, DeKalb, Cobb, Gwinnett, Clayton county and city races, plus how each county is
voting at the top of the ticket).

Numbers come from official state results feeds, not the AP. Nothing here projects
winners; a "Called" badge only appears when you add one by hand.

## How it works

```
GitHub Actions run (every ~2-3 min on election night)
  └─ fetcher/run.py ── pulls each state feed ──> data/results.json
       └─ published with site/ to GitHub Pages
            └─ every open browser re-checks results.json once a minute
```

| Source | Covers | Feed | Status |
|---|---|---|---|
| Georgia SOS (Enhanced Voting) | Georgia + Metro tabs, GA Senate/Governor | JSON/ZIP export, refreshed at most once a minute | Format confirmed from the state's media guide |
| NC State Board of Elections | NC Senate, NC-01, NC-11 | Precinct TSV zip on S3 | Format confirmed (column layout) |
| Minnesota SOS | MN Senate | Semicolon text files | Format long-standing; **2026 URL unconfirmed** |
| Everything else | All other states | Link to official results; numbers via `manual.yml` | See below |

States like Maine, New Hampshire and Wisconsin don't publish statewide election-night
results at all, and Texas's machine-readable feed is a paid subscription. Those races show
"No feed" with a link to the official results page, and you can type numbers into
`config/manual.yml` if you want them on screen.

## One-time setup (do this before Nov 3)

1. Create a new public repo named `election-night` under `hantsiakiann` and push this
   folder to `main`. Keeping it separate means it can't disturb your main site; it will
   live at `https://hantsiakiann.github.io/election-night/`.
2. Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
3. Repo **Settings > Secrets and variables > Actions > Variables**: add
   `TRACKER_LIVE` = `false` for now.
4. **Actions tab > Update results > Run workflow** once. The site should come up showing
   "No feed" rows and a Georgia notice; that's expected before the election.

## Before election night

- **Georgia election ID.** When the Secretary of State lists the Nov 3 election at
  results.sos.ga.gov, copy the last part of its URL into `sources.georgia.election_id`
  in `config/races.yml`. The state usually posts a zero-vote file beforehand, so you can
  confirm it works by running the workflow and opening the Georgia tab.
- **Check contest names.** Locally, run `python -m fetcher.run --list-contests` to print
  every contest name each feed publishes, and adjust `national.patterns` in
  `config/races.yml` if a race with a feed shows "Not in the state feed yet".
- **Minnesota URL.** Confirm the media-file path on the MN SOS results site; update
  `sources.mn.base` if it moved.
- **Add a state feed** if you find one: if it's JSON, add a `json_map` source (template
  in `config/races.yml`; `python -m fetcher.probe <url>` prints the feed's fields), add the
  state to `national.feeds`, and give the source its contest-name `patterns`.
- **Key races** (shown by default for the House) are listed under `national.key`.

## Election night

1. Set `TRACKER_LIVE` = `true`, then **Run workflow** once (around 6:30 pm ET). Each run
   queues the next, so the site refreshes every ~2-3 minutes. A schedule every 10 min
   acts as a backup if the chain stops, and chaining shuts itself off after Nov 6.
2. To post a call or hand-entered numbers, edit `config/manual.yml` on GitHub (the pencil
   icon works on a phone). Every card shows its id in the corner (e.g. `SEN-MI`).
3. When you're done, set `TRACKER_LIVE` = `false`.

If a feed goes down mid-night, its races keep the last numbers received and are marked
"Feed down".

## Maps

- **Senate and Governor:** a U.S. map colored by who leads each race (deeper color = wider
  margin; hatched = no votes yet), plus a bar counting seats toward control. The Senate bar
  includes the 65 seats not up this year (34 D, 31 R).
- **House:** a tile map with one square per district, grouped by state. It's a tile map
  rather than real district shapes because several states redrew their lines for 2026.
- **County maps:** every statewide race whose feed reports by county (Georgia and North
  Carolina) gets a county map; Senate and Governor open automatically. Hover or tap a
  county for its numbers.
- Click a state (or a House square) to filter the list to that state.

## Page features

Closest-first sort, search by race or candidate, large-text mode for a TV, a brief
highlight on rows whose count just moved, a "Leader under 50%" flag for Georgia's runoff
rule, and deep links (`#georgia`, `#metro/Fulton`, `#national/senate`).

## Testing offline

```
pip install -r requirements.txt
bash fixtures/test.sh 0.45      # fake data, 45% reporting; open http://localhost:8000
bash fixtures/test.sh 0.9       # re-run to simulate the night progressing
```

The fixtures are invented data built to match each state's published format.
