/* Maps for the tracker: U.S. state map (Senate/Governor), House tile map, county maps.
   Geometry: us-atlas (pre-projected Albers USA, 975x610), bundled in geo/. */
window.ENMaps = (() => {
  "use strict";
  const PARTY = { D: "var(--dem)", R: "var(--rep)", L: "var(--lib)", G: "var(--grn)" };
  const NEUTRAL = ["var(--np1)", "var(--np2)", "var(--np3)", "var(--np4)", "var(--oth)"];
  const cache = {};
  const loadGeo = (name) => (cache[name] ||= fetch(`geo/${name}.json`).then((r) => {
    if (!r.ok) throw new Error(`geo/${name}.json ${r.status}`);
    return r.json();
  }));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+(county|parish)$/, "").replace(/[^a-z]/g, "");
  const pct1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

  // Fill for a lead: party color, deeper as the margin widens (called races are full strength).
  function leadFill(base, margin, called) {
    if (called) return base;
    const strength = Math.round(28 + Math.min(1, Math.abs(margin) / 20) * 62); // 28%..90%
    return `color-mix(in srgb, ${base} ${strength}%, var(--map-blank))`;
  }
  function raceFill(r) {
    if (!r) return "var(--map-none)";
    if (!r.total_votes) return "url(#hatch)";
    const lead = r.candidates[0];
    const base = PARTY[lead.party] || "var(--oth)";
    const called = r.call && r.call === lead.name;
    if (r.call && !called) { // called for someone who isn't leading the count: color by the call
      const c = r.candidates.find((x) => x.name === r.call);
      return PARTY[c?.party] || "var(--oth)";
    }
    return leadFill(base, r.margin_pct ?? 0, called);
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
  function raceTip(title, r, extra = "") {
    if (!r) return `<b>${esc(title)}</b><br>No race this year`;
    if (!r.total_votes) return `<b>${esc(title)}</b><br>${r.status === "no-feed" ? "No live feed; see official results" : "No votes counted yet"}`;
    const rows = r.candidates.slice(0, 3).map((c) =>
      `<tr><td>${esc(c.name)}${c.party ? ` (${esc(c.party)})` : ""}</td><td>${pct1(c.pct)}%</td></tr>`).join("");
    const rep = r.reporting_pct != null ? `${Math.round(r.reporting_pct)}% reporting` : "";
    return `<b>${esc(title)}</b>${r.call ? `<br>Called for ${esc(r.call)}` : ""}<table>${rows}</table>${rep}${extra}`;
  }
  const hatchDefs = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="var(--map-blank)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--map-hatch)" stroke-width="2"/></pattern></defs>`;

  function bindTips(svg, html, click) {
    svg.addEventListener("pointermove", (e) => {
      const el = e.target.closest("[data-k]");
      if (!el) return hideTip();
      showTip(e, html(el.dataset.k));
    });
    svg.addEventListener("pointerleave", hideTip);
    if (click) svg.addEventListener("click", (e) => { const el = e.target.closest("[data-k]"); if (el) { hideTip(); click(el.dataset.k); } });
  }

  // ---------------------------------------------------------------- U.S. state map
  async function usMap(el, races, states, { onPick, selected } = {}) {
    const topo = await loadGeo("states");
    const byFips = Object.fromEntries(states.map((s) => [s.fips, s]));
    const raceBy = Object.fromEntries(races.map((r) => [r.state, r]));
    const feats = topojson.feature(topo, topo.objects.states).features.filter((f) => byFips[f.id]);
    const path = d3.geoPath();
    const shapes = feats.map((f) => {
      const s = byFips[f.id], r = raceBy[s.abbr];
      const sel = selected === s.abbr ? " sel" : "";
      return `<path data-k="${s.abbr}" class="st${r ? " has" : ""}${sel}" d="${path(f)}" style="fill:${raceFill(r)}"/>`;
    }).join("");
    const mesh = path(topojson.mesh(topo, topo.objects.states, (a, b) => a !== b));
    el.innerHTML = `<svg viewBox="0 0 975 610" class="usmap" role="img" aria-label="Map of races by state; the list below has the same results">
      ${hatchDefs}<g>${shapes}</g><path class="mesh" d="${mesh}"/></svg>`;
    const names = Object.fromEntries(states.map((s) => [s.abbr, s.name]));
    bindTips(el.querySelector("svg"), (k) => raceTip(names[k] + (raceBy[k]?.special ? " (special)" : ""), raceBy[k]),
      (k) => raceBy[k] && onPick?.(k));
  }

  // ---------------------------------------------------------------- House tile map
  function houseTiles(el, races, states, { onPick, selected } = {}) {
    const T = 64, G = 6;
    const byState = {};
    races.forEach((r) => (byState[r.state] ||= []).push(r));
    let cells = "";
    for (const s of states) {
      const list = (byState[s.abbr] || []).sort((a, b) => a.district - b.district);
      if (!list.length) continue;
      const x0 = s.x * (T + G), y0 = s.y * (T + G);
      const cols = Math.ceil(Math.sqrt(list.length)), rows = Math.ceil(list.length / cols);
      const top = 15, inner = T - 4, size = Math.min(inner / cols, (T - top - 2) / rows), gap = Math.max(.6, size * .12);
      cells += `<g class="tile${selected === s.abbr ? " sel" : ""}" transform="translate(${x0},${y0})">
        <rect class="tilebg" width="${T}" height="${T}" rx="4" data-k="${s.abbr}"/>
        <text x="4" y="11">${s.abbr}</text>`;
      const offX = (T - cols * size) / 2;
      list.forEach((r, i) => {
        const cx = offX + (i % cols) * size, cy = top + Math.floor(i / cols) * size;
        cells += `<rect data-k="${r.id}" x="${cx + gap / 2}" y="${cy + gap / 2}" width="${size - gap}" height="${size - gap}" rx="${Math.min(2, size / 6)}" style="fill:${raceFill(r)}"/>`;
      });
      cells += "</g>";
    }
    const W = 12 * (T + G), H = 8 * (T + G);
    el.innerHTML = `<svg viewBox="-2 -2 ${W + 4} ${H + 4}" class="tilemap" role="img" aria-label="House districts by state, one square per seat; the list below has the same results">${hatchDefs}${cells}</svg>`;
    const byId = Object.fromEntries(races.map((r) => [r.id, r]));
    const names = Object.fromEntries(states.map((s) => [s.abbr, s.name]));
    bindTips(el.querySelector("svg"), (k) => byId[k] ? raceTip(byId[k].title, byId[k]) : `<b>${esc(names[k])}</b><br>${(byState[k] || []).length} seats`,
      (k) => onPick?.(byId[k] ? byId[k].state : k));
  }

  // ---------------------------------------------------------------- county map
  async function countyMap(el, r, stateFips) {
    const topo = await loadGeo("counties");
    const feats = topojson.feature(topo, topo.objects.counties).features.filter((f) => f.id.startsWith(stateFips));
    if (!feats.length) { el.textContent = "No county shapes for this state."; return; }
    const W = 560, H = 420;
    const proj = d3.geoIdentity().fitExtent([[6, 6], [W - 6, H - 6]], { type: "FeatureCollection", features: feats });
    const path = d3.geoPath(proj);
    const partisan = r.candidates.some((c) => c.party);
    const rows = Object.fromEntries((r.counties || []).map((row) => [norm(row[0]), row]));
    let matched = 0;
    const shapes = feats.map((f) => {
      const row = rows[norm(f.properties.name)];
      let fill = "var(--map-blank)";
      if (row) {
        matched++;
        const v = row[2], tot = v.reduce((a, b) => a + b, 0);
        if (tot) {
          const order = v.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]);
          const [first, second = [0]] = order, i = first[1];
          const base = partisan ? (PARTY[r.candidates[i]?.party] || "var(--oth)") : NEUTRAL[i % NEUTRAL.length];
          fill = leadFill(base, 100 * (first[0] - second[0]) / tot, false);
        } else fill = "url(#hatch)";
      }
      return `<path data-k="${esc(f.properties.name)}" d="${path(f)}" style="fill:${fill}"/>`;
    }).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="cmapsvg" role="img" aria-label="County results for ${esc(r.title)}">${hatchDefs}${shapes}</svg>
      ${matched < Object.keys(rows).length ? `<p class="cmapnote">${Object.keys(rows).length - matched} counties in the feed didn't match a map shape.</p>` : ""}`;
    bindTips(el.querySelector("svg"), (name) => {
      const row = rows[norm(name)];
      if (!row) return `<b>${esc(name)}</b><br>Not in this contest`;
      const tot = row[2].reduce((a, b) => a + b, 0);
      if (!tot) return `<b>${esc(name)}</b><br>No votes counted yet`;
      const lines = r.candidates.map((c, i) => [c, row[2][i]]).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([c, v]) => `<tr><td>${esc(c.name)}</td><td>${pct1(100 * v / tot)}%</td><td>${v.toLocaleString("en-US")}</td></tr>`).join("");
      return `<b>${esc(name)}</b><table>${lines}</table>${row[1] != null ? `${Math.round(row[1])}% of precincts reporting` : ""}`;
    });
  }

  return { usMap, houseTiles, countyMap, raceFill };
})();
