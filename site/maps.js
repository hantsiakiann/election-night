/* Maps for the tracker: U.S. state map with zoom into counties (Senate/Governor),
   House district grid, and per-race county maps.
   Geometry: us-atlas (pre-projected Albers USA, 975x610) and a generated district grid, in geo/. */
window.ENMaps = (() => {
  "use strict";
  const PARTY = { D: "var(--dem)", R: "var(--rep)", L: "var(--lib)", G: "var(--grn)" };
  const NEUTRAL = ["var(--np1)", "var(--np2)", "var(--np3)", "var(--np4)", "var(--oth)"];
  const MUTED = { D: "var(--dem-muted)", R: "var(--rep-muted)" };
  const HELD = { D: "Democrat", R: "Republican" };
  const W = 975, H = 610;
  const cache = {};
  const loadGeo = (name) => (cache[name] ||= fetch(`geo/${name}.json`).then((r) => {
    if (!r.ok) throw new Error(`geo/${name}.json ${r.status}`);
    return r.json();
  }));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+(county|parish)$/, "").replace(/[^a-z]/g, "");
  const pct1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- colors
  function leadFill(base, margin, called) {
    if (called) return base;
    const strength = Math.round(55 + Math.min(1, Math.abs(margin) / 20) * 40); // 55%..95%
    return `color-mix(in srgb, ${base} ${strength}%, var(--map-blank))`;
  }
  function raceFill(r, held) {
    if (!r) return MUTED[held] || "var(--map-none)";               // no race this year
    if (r.call) {
      const c = r.candidates.find((x) => x.name === r.call);
      if (c) return PARTY[c.party] || "var(--oth)";
    }
    if (!r.total_votes) {
      if (r.decided) return PARTY[r.decided.party] || "var(--oth)";  // settled before Election Day
      return held && MUTED[held] ? `url(#hatch${held})` : "url(#hatch)";
    }
    const lead = r.candidates[0];
    return leadFill(PARTY[lead.party] || "var(--oth)", r.margin_pct ?? 0, false);
  }
  function countyFill(row, cands, partisan) {
    const v = row[2], tot = v.reduce((a, b) => a + b, 0);
    if (!tot) return "url(#hatch)";
    const order = v.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]);
    const [first, second = [0]] = order, i = first[1];
    const base = partisan ? (PARTY[cands[i]?.party] || "var(--oth)") : NEUTRAL[i % NEUTRAL.length];
    return leadFill(base, 100 * (first[0] - second[0]) / tot, false);
  }

  // ---------------------------------------------------------------- tooltip
  let tip;
  function showTip(evt, html) {
    tip ||= Object.assign(document.body.appendChild(document.createElement("div")), { className: "maptip", role: "tooltip" });
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };
  function raceTip(title, r, held) {
    const h = held && HELD[held] ? `<br>Held by a ${HELD[held]} now` : "";
    if (!r) return `<b>${esc(title)}</b><br>No race this year${h}`;
    const dec = r.decided ? `<br>${esc(r.decided.winner ? `${r.decided.winner} (${r.decided.party}), unopposed` : r.decided.reason)}` : "";
    if (!r.total_votes) return `<b>${esc(title)}</b>${h}${dec}${dec ? "" : `<br>${r.status === "no-feed" ? "No live feed; see official results" : "No votes counted yet"}`}`;
    const rows = r.candidates.slice(0, 3).map((c) =>
      `<tr><td>${esc(c.name)}${c.party ? ` (${esc(c.party)})` : ""}</td><td>${pct1(c.pct)}%</td></tr>`).join("");
    const rep = r.reporting_pct != null ? `${Math.round(r.reporting_pct)}% reporting` : "";
    return `<b>${esc(title)}</b>${r.call ? `<br>Called for ${esc(r.call)}` : ""}<table>${rows}</table>${rep}`;
  }
  function countyTip(name, r, rows) {
    const row = rows[norm(name)];
    if (!row) return `<b>${esc(name)}</b><br>${r?.counties ? "Not in this contest" : "No county results from this state's feed"}`;
    const tot = row[2].reduce((a, b) => a + b, 0);
    if (!tot) return `<b>${esc(name)}</b><br>No votes counted yet`;
    const lines = r.candidates.map((c, i) => [c, row[2][i]]).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, v]) => `<tr><td>${esc(c.name)}</td><td>${pct1(100 * v / tot)}%</td><td>${v.toLocaleString("en-US")}</td></tr>`).join("");
    return `<b>${esc(name)}</b><table>${lines}</table>${row[1] != null ? `${Math.round(row[1])}% of precincts reporting` : ""}`;
  }
  const pat = (id, bg) => `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="${bg}"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--map-hatch)" stroke-width="2"/></pattern>`;
  const defs = (scale = 1) => `<defs>${pat("hatch", "var(--map-blank)")}${pat("hatchD", "var(--dem-muted)")}${pat("hatchR", "var(--rep-muted)")}</defs>`;

  function bindTips(svg, html, click) {
    svg.addEventListener("pointermove", (e) => {
      const el = e.target.closest("[data-k]");
      if (!el) return hideTip();
      showTip(e, html(el.dataset.k));
    });
    svg.addEventListener("pointerleave", hideTip);
    if (click) svg.addEventListener("click", (e) => { const el = e.target.closest("[data-k]"); if (el) { hideTip(); click(el.dataset.k); } });
  }

  // ---------------------------------------------------------------- U.S. map + zoom into a state
  function fitTransform(b, pad = 0.9) {
    const [[x0, y0], [x1, y1]] = b;
    const k = Math.min(pad / Math.max((x1 - x0) / W, (y1 - y0) / H), 14);
    return { k, x: W / 2 - k * (x0 + x1) / 2, y: H / 2 - k * (y0 + y1) / 2 };
  }
  const tstr = (t) => `translate(${t.x},${t.y}) scale(${t.k})`;
  const IDENTITY = { k: 1, x: 0, y: 0 };

  /* opts: selected (abbr to show zoomed), animate ("in" | "out" | null), from (abbr zoomed before
     zooming out), held ({abbr: party}), onPick(abbr) */
  async function usMap(el, races, states, opts = {}) {
    const { selected, animate, from, held = {}, onPick } = opts;
    const topo = await loadGeo("states");
    const byFips = Object.fromEntries(states.map((s) => [s.fips, s]));
    const byAbbr = Object.fromEntries(states.map((s) => [s.abbr, s]));
    const raceBy = Object.fromEntries(races.map((r) => [r.state, r]));
    const feats = topojson.feature(topo, topo.objects.states).features.filter((f) => byFips[f.id]);
    const featBy = Object.fromEntries(feats.map((f) => [byFips[f.id].abbr, f]));
    const path = d3.geoPath();
    const shapes = feats.map((f) => {
      const s = byFips[f.id], r = raceBy[s.abbr];
      return `<path data-k="${s.abbr}" class="st${r ? " has" : ""}${selected === s.abbr ? " sel" : ""}" d="${path(f)}" style="fill:${raceFill(r, held[s.abbr])}"/>`;
    }).join("");
    const mesh = path(topojson.mesh(topo, topo.objects.states, (a, b) => a !== b));
    const focus = selected || (animate === "out" ? from : null);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="usmap${selected ? " zoomed" : ""}" role="img"
        aria-label="${selected ? `${esc(byAbbr[selected]?.name)} by county` : "Map of races by state"}; the list below has the same results">
      ${defs()}<g class="world"><g class="states">${shapes}</g><path class="mesh" d="${mesh}"/><g class="counties"></g></g></svg>`;
    const svg = el.querySelector("svg"), world = svg.querySelector(".world");

    // county layer for the focused state
    let rows = {}, focusRace = focus ? raceBy[focus] : null;
    if (focus && featBy[focus]) {
      const ctopo = await loadGeo("counties");
      const fips = byAbbr[focus].fips;
      const cfeats = topojson.feature(ctopo, ctopo.objects.counties).features.filter((f) => f.id.startsWith(fips));
      rows = Object.fromEntries((focusRace?.counties || []).map((row) => [norm(row[0]), row]));
      const partisan = focusRace?.candidates?.some((c) => c.party);
      const baseFill = MUTED[held[focus]] || "var(--map-blank)";
      svg.querySelector(".counties").innerHTML = cfeats.map((f) => {
        const row = rows[norm(f.properties.name)];
        const fill = row ? countyFill(row, focusRace.candidates, partisan) : baseFill;
        return `<path data-k="c:${esc(f.properties.name)}" d="${path(f)}" style="fill:${fill}"/>`;
      }).join("");
    }

    const target = selected ? fitTransform(path.bounds(featBy[selected])) : IDENTITY;
    const start = animate === "in" ? IDENTITY : animate === "out" && from && featBy[from] ? fitTransform(path.bounds(featBy[from])) : target;
    world.setAttribute("transform", tstr(start));
    if (start !== target) {
      if (selected || animate === "out") svg.classList.add("zoomed");
      d3.select(world).transition().duration(reduceMotion() ? 0 : 750).ease(d3.easeCubicInOut)
        .attr("transform", tstr(target))
        .on("end", () => { if (!selected) { svg.classList.remove("zoomed"); svg.querySelector(".counties").innerHTML = ""; } });
    }

    bindTips(svg, (k) => k.startsWith("c:") ? countyTip(k.slice(2), focusRace, rows)
      : raceTip(byAbbr[k].name + (raceBy[k]?.special ? " (special)" : ""), raceBy[k], held[k]),
    (k) => { if (!k.startsWith("c:") && raceBy[k]) onPick?.(k); });
    return { hasCounties: !!focusRace?.counties?.length };
  }

  // ---------------------------------------------------------------- House district grid
  async function houseGrid(el, races, states, { onPick, selected } = {}) {
    const grid = await loadGeo("house_grid");
    const S = 22;
    const byId = Object.fromEntries(races.map((r) => [r.id, r]));
    const seats = Object.fromEntries(states.map((s) => [s.abbr, s.seats]));
    const names = Object.fromEntries(states.map((s) => [s.abbr, s.name]));
    const owner = new Map(grid.cells.map(([s, , x, y]) => [`${x},${y}`, s]));
    let rects = "", edges = "";
    const cellsBy = {};
    for (const [s, n, x, y] of grid.cells) {
      const id = seats[s] === 1 ? `H-${s}-AL` : `H-${s}-${String(n).padStart(2, "0")}`;
      const r = byId[id];
      (cellsBy[s] ||= []).push([x, y]);
      rects += `<rect data-k="${id}" class="${selected && selected !== s ? "dim" : ""}" x="${x * S + 1}" y="${y * S + 1}" width="${S - 2}" height="${S - 2}" rx="2" style="fill:${raceFill(r)}"/>`;
      // state borders: edges where the neighbor belongs to another state (or nothing)
      if (owner.get(`${x},${y - 1}`) !== s) edges += `M${x * S},${y * S}h${S}`;
      if (owner.get(`${x},${y + 1}`) !== s) edges += `M${x * S},${(y + 1) * S}h${S}`;
      if (owner.get(`${x - 1},${y}`) !== s) edges += `M${x * S},${y * S}v${S}`;
      if (owner.get(`${x + 1},${y}`) !== s) edges += `M${(x + 1) * S},${y * S}v${S}`;
    }
    // label each state on its cell nearest the block's center
    const labels = Object.entries(cellsBy).map(([s, pts]) => {
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const [x, y] = pts.reduce((b, p) => (Math.hypot(p[0] - cx, p[1] - cy) < Math.hypot(b[0] - cx, b[1] - cy) ? p : b));
      return `<text x="${x * S + S / 2}" y="${y * S + S / 2 + 3.5}">${s}</text>`;
    }).join("");
    el.innerHTML = `<svg viewBox="-4 -4 ${grid.w * S + 8} ${grid.h * S + 8}" class="housegrid" role="img"
        aria-label="House districts, one equal square per seat, grouped by state; the list below has the same results">
      ${defs()}<g>${rects}</g><path class="borders" d="${edges}"/><g class="labels">${labels}</g></svg>`;
    bindTips(el.querySelector("svg"), (k) => {
      const r = byId[k];
      return r ? raceTip(r.title, r) : "";
    }, (k) => byId[k] && onPick?.(byId[k].state));
  }

  // ---------------------------------------------------------------- county map inside a race row
  async function countyMap(el, r, stateFips) {
    const topo = await loadGeo("counties");
    const feats = topojson.feature(topo, topo.objects.counties).features.filter((f) => f.id.startsWith(stateFips));
    if (!feats.length) { el.textContent = "No county shapes for this state."; return; }
    const CW = 560, CH = 420;
    const proj = d3.geoIdentity().fitExtent([[6, 6], [CW - 6, CH - 6]], { type: "FeatureCollection", features: feats });
    const path = d3.geoPath(proj);
    const partisan = r.candidates.some((c) => c.party);
    const rows = Object.fromEntries((r.counties || []).map((row) => [norm(row[0]), row]));
    let matched = 0;
    const shapes = feats.map((f) => {
      const row = rows[norm(f.properties.name)];
      if (row) matched++;
      return `<path data-k="${esc(f.properties.name)}" d="${path(f)}" style="fill:${row ? countyFill(row, r.candidates, partisan) : "var(--map-blank)"}"/>`;
    }).join("");
    const unmatched = Object.keys(rows).length - matched;
    el.innerHTML = `<svg viewBox="0 0 ${CW} ${CH}" class="cmapsvg" role="img" aria-label="County results for ${esc(r.title)}">${defs()}${shapes}</svg>
      ${unmatched > 0 ? `<p class="cmapnote">${unmatched} counties in the feed didn't match a map shape.</p>` : ""}`;
    bindTips(el.querySelector("svg"), (name) => countyTip(name, r, rows));
  }

  return { usMap, houseGrid, countyMap, raceFill };
})();
