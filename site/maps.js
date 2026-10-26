/* Maps for the tracker: U.S. state map with zoom into counties (Senate/Governor),
   House district grid, and per-race county maps.
   Geometry: us-atlas (pre-projected Albers USA, 975x610) and a generated district grid, in geo/. */
window.ENMaps = (() => {
  "use strict";
  const PARTY = { D: "var(--dem)", R: "var(--rep)", L: "var(--lib)", G: "var(--grn)", I: "var(--ind)", C: "var(--con)", WF: "var(--wf)" };
  const NEUTRAL = ["var(--np1)", "var(--np2)", "var(--np3)", "var(--np4)", "var(--oth)"];
  const PARTY_NAME = { D: "Democrat", R: "Republican", L: "Libertarian", G: "Green", I: "Independent", C: "Constitution", WF: "Working Families" };
  const partyName = (p) => PARTY_NAME[p] || p || "";
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
  // Party currently ahead: the called winner, the vote leader, or a party settled before Election Day.
  function leadParty(r) {
    if (!r) return null;
    if (r.call) { const c = r.candidates.find((x) => x.name === r.call); if (c) return c.party; }
    if (r.total_votes) return r.candidates[0]?.party || null;
    return r.decided?.party || null;
  }
  // A flip: the party ahead differs from the party holding the seat now (D/R only).
  function isFlip(r) {
    const p = leadParty(r);
    return !!(r?.held && (p === "D" || p === "R") && (r.held === "D" || r.held === "R") && p !== r.held);
  }
  // notUp: for states with no race this year, the party holding the seat(s): D, R or "split"
  function raceFill(r, notUp) {
    if (!r) return notUp === "split" ? "var(--split)" : PARTY[notUp] || "var(--map-none)";
    const p = leadParty(r);
    if (!p) return "var(--map-blank)";                                // no results yet: plain gray
    const base = PARTY[p] || "var(--oth)";
    if (r.call || (!r.total_votes && r.decided)) return base;         // called / settled: full color
    return leadFill(base, r.margin_pct ?? 0, false);
  }
  const MEASURE = { yes: "var(--yes)", for: "var(--yes)", no: "var(--no)", against: "var(--no)" };
  function countyFill(row, cands, partisan) {
    const v = row[2], tot = v.reduce((a, b) => a + b, 0);
    if (!tot) return "var(--map-blank)";
    const order = v.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]);
    const [first, second = [0]] = order, i = first[1];
    const base = MEASURE[(cands[i]?.name || "").trim().toLowerCase()]
      || (partisan ? (PARTY[cands[i]?.party] || "var(--oth)") : NEUTRAL[i % NEUTRAL.length]);
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
  function raceTip(title, r, held, notUpText) {
    const h = held && HELD[held] ? `<br>Held by a ${HELD[held]} now` : "";
    if (!r) return `<b>${esc(title)}</b><br>No race this year${notUpText ? `<br>${esc(notUpText)}` : ""}`;
    const dec = r.decided ? `<br>${esc(r.decided.winner ? `${r.decided.winner} (${r.decided.party}), unopposed` : r.decided.reason)}` : "";
    const flip = isFlip(r) ? `<br><b>Flip</b> from ${HELD[r.held]}s` : "";
    if (!r.total_votes) return `<b>${esc(title)}</b>${h}${dec}${flip}${dec ? "" : `<br>${r.status === "no-feed" ? "No live feed; see official results" : "No votes counted yet"}`}`;
    const rows = r.candidates.slice(0, 3).map((c) =>
      `<tr><td>${esc(c.name)}</td><td class="pty">${esc(partyName(c.party))}</td><td>${pct1(c.pct)}%</td></tr>`).join("");
    const rep = r.reporting_pct != null ? `${Math.round(r.reporting_pct)}% reporting` : "";
    return `<b>${esc(title)}</b>${r.call ? `<br>Called for ${esc(r.call)}` : ""}${flip}<table>${rows}</table>${rep}`;
  }
  function countyTip(name, r, rows) {
    const row = rows[norm(name)];
    if (!row) return `<b>${esc(name)}</b><br>${r?.counties ? "Not in this contest" : "No county results from this state's feed"}`;
    const tot = row[2].reduce((a, b) => a + b, 0);
    if (!tot) return `<b>${esc(name)}</b><br>No votes counted yet`;
    const lines = r.candidates.map((c, i) => [c, row[2][i]]).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, v]) => `<tr><td>${esc(c.name)}</td><td class="pty">${esc(partyName(c.party))}</td><td>${pct1(100 * v / tot)}%</td><td>${v.toLocaleString("en-US")}</td></tr>`).join("");
    return `<b>${esc(name)}</b><table>${lines}</table>${row[1] != null ? `${Math.round(row[1])}% of precincts reporting` : ""}`;
  }
  const pat = (id, bg) => `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="${bg}"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--map-hatch)" stroke-width="2"/></pattern>`;
  // stripes laid over a party color to mark a flipped seat
  const flipPat = `<pattern id="flip" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="7" stroke="var(--flip-stripe)" stroke-width="2.6"/></pattern>`;
  const defs = () => `<defs>${pat("hatch", "var(--map-blank)")}${flipPat}</defs>`;

  // Outlines for the hovered or selected shape go on a top layer, so neighbors drawn later
  // never cover them.
  const SVGNS = "http://www.w3.org/2000/svg";
  function topLayer(svg, el) {
    const g = el.closest(".world") || svg;
    let layer = [...g.children].find((c) => c.classList?.contains("hl-layer"));
    if (!layer) { layer = document.createElementNS(SVGNS, "g"); layer.setAttribute("class", "hl-layer"); }
    g.appendChild(layer);  // (re)append so it stays last
    return layer;
  }
  function outline(svg, el, cls) {
    if (!el || !/^(path|rect)$/i.test(el.tagName)) return null;
    const c = el.cloneNode(false);
    c.removeAttribute("data-k"); c.removeAttribute("style"); c.removeAttribute("id");
    c.setAttribute("class", cls);
    topLayer(svg, el).appendChild(c);
    return c;
  }
  function bindTips(svg, html, click) {
    let cur = null, hl = null;
    const clear = () => { hl?.remove(); hl = null; cur = null; };
    svg.addEventListener("pointermove", (e) => {
      const el = e.target.closest("[data-k]");
      if (!el) { clear(); return hideTip(); }
      if (el !== cur) { clear(); cur = el; hl = outline(svg, el, "hl"); }
      showTip(e, html(el.dataset.k));
    });
    svg.addEventListener("pointerleave", () => { clear(); hideTip(); });
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
  // Smooth pan+zoom between two transforms (d3.interpolateZoom zooms out a little while
  // panning between two zoomed-in states, so a jump to a neighbor reads as a move).
  function flyTo(world, a, b, done) {
    const toView = (t) => [(W / 2 - t.x) / t.k, (H / 2 - t.y) / t.k, W / t.k];
    const fromView = ([cx, cy, w]) => { const k = W / w; return { k, x: W / 2 - k * cx, y: H / 2 - k * cy }; };
    const zi = d3.interpolateZoom(toView(a), toView(b));
    const ms = reduceMotion() ? 0 : Math.max(650, Math.min(1100, zi.duration * 0.9));
    d3.select(world).transition().duration(ms).ease(d3.easeCubicInOut)
      .attrTween("transform", () => (t) => tstr(fromView(zi(t))))
      .on("end", () => { world.setAttribute("transform", tstr(b)); done?.(); });
  }

  /* opts: selected (abbr to show zoomed), animate ("in" | "out" | null), from (abbr zoomed before
     zooming out), held ({abbr: party}), onPick(abbr) */
  async function usMap(el, races, states, opts = {}) {
    const { selected, animate, from, held = {}, notUp = {}, notUpText = () => "", onPick } = opts;
    const topo = await loadGeo("states");
    const byFips = Object.fromEntries(states.map((s) => [s.fips, s]));
    const byAbbr = Object.fromEntries(states.map((s) => [s.abbr, s]));
    const raceBy = Object.fromEntries(races.map((r) => [r.state, r]));
    const feats = topojson.feature(topo, topo.objects.states).features.filter((f) => byFips[f.id]);
    const featBy = Object.fromEntries(feats.map((f) => [byFips[f.id].abbr, f]));
    const path = d3.geoPath();
    const shapes = feats.map((f) => {
      const s = byFips[f.id], r = raceBy[s.abbr];
      const d = path(f);
      return `<path data-k="${s.abbr}" class="st${r ? " has" : ""}${selected === s.abbr ? " sel" : ""}" d="${d}" style="fill:${raceFill(r, notUp[s.abbr])}"/>` +
        (isFlip(r) ? `<path class="flipover" d="${d}" fill="url(#flip)"/>` : "");
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
      const baseFill = "var(--map-blank)";
      svg.querySelector(".counties").innerHTML = cfeats.map((f) => {
        const row = rows[norm(f.properties.name)];
        const fill = row ? countyFill(row, focusRace.candidates, partisan) : baseFill;
        return `<path data-k="c:${esc(f.properties.name)}" d="${path(f)}" style="fill:${fill}"/>`;
      }).join("");
    }

    const selEl = selected && svg.querySelector(`.states path[data-k="${selected}"]`);
    if (selEl) outline(svg, selEl, "hl hl-sel");
    const target = selected ? fitTransform(path.bounds(featBy[selected])) : IDENTITY;
    const start = animate === "in" ? IDENTITY : (animate === "out" || animate === "move") && from && featBy[from] ? fitTransform(path.bounds(featBy[from])) : target;
    world.setAttribute("transform", tstr(start));
    if (start !== target) {
      if (selected || animate === "out") svg.classList.add("zoomed");
      flyTo(world, start, target, () => { if (!selected) { svg.classList.remove("zoomed"); svg.querySelector(".counties").innerHTML = ""; } });
    }

    bindTips(svg, (k) => k.startsWith("c:") ? countyTip(k.slice(2), focusRace, rows)
      : raceTip(byAbbr[k].name + (raceBy[k]?.special ? " (special)" : ""), raceBy[k], held[k], notUpText(k)),
    (k) => { if (!k.startsWith("c:") && raceBy[k]) onPick?.(k); });
    return { hasCounties: !!focusRace?.counties?.length };
  }

  // ---------------------------------------------------------------- House district grid
  async function houseGrid(el, races, states, { onPick, selected, selectedDist } = {}) {
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
      const cls = selected && selected !== s ? "dim" : selectedDist && selectedDist !== id ? "dim2" : "";
      rects += `<rect data-k="${id}" class="${cls}" x="${x * S + 1}" y="${y * S + 1}" width="${S - 2}" height="${S - 2}" rx="2" style="fill:${raceFill(r)}"/>`;
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
    const gsvg = el.querySelector("svg");
    if (selectedDist) outline(gsvg, gsvg.querySelector(`rect[data-k="${selectedDist}"]`), "hl hl-sel");
    bindTips(gsvg, (k) => {
      const r = byId[k];
      return r ? raceTip(r.title, r) : "";
    }, (k) => byId[k] && onPick?.(byId[k].state, k));
  }

  // ---------------------------------------------------------------- House: real district map
  /* Districts from geo/districts.json (Census 2024 lines). States listed in newLines redrew for
     2026, so instead of out-of-date lines they're shaded in bands by share of seats each party
     leads. If the district file is missing, every state is shaded that way. */
  async function houseGeo(el, races, states, opts = {}) {
    // selected: state abbr; selectedDist: race id ("H-GA-05"); zoomFrom: view before this one
    // ("" = whole U.S., "GA" = a state, "H-GA-05" = a district; undefined = no animation)
    const { selected, selectedDist, zoomFrom, newLines = [], onPick } = opts;
    const stopo = await loadGeo("states");
    let dtopo = null;
    try { dtopo = await loadGeo("districts"); } catch { /* not built yet: fall back to bands */ }
    const byFips = Object.fromEntries(states.map((s) => [s.fips, s]));
    const byAbbr = Object.fromEntries(states.map((s) => [s.abbr, s]));
    const byKey = Object.fromEntries(races.map((r) => [r.id.replace(/^H-/, ""), r]));
    const path = d3.geoPath();
    const sfeats = topojson.feature(stopo, stopo.objects.states).features.filter((f) => byFips[f.id]);
    const featBy = Object.fromEntries(sfeats.map((f) => [byFips[f.id].abbr, f]));
    const dfeats = dtopo ? topojson.feature(dtopo, dtopo.objects.districts).features : [];
    // states drawn with district lines: Census lines still in use, or 2026 lines loaded for a redrawn state
    const mapped = new Set(dfeats.filter((f) => !newLines.includes(f.id.slice(0, 2)) || f.properties?.src === "2026")
      .map((f) => f.id.slice(0, 2)));
    const seatsBy = {};
    races.forEach((r) => (seatsBy[r.state] ||= []).push(r));
    const tally = (st) => {
      const t = { D: 0, R: 0, none: 0 };
      for (const r of seatsBy[st] || []) {
        const who = r.call ? r.candidates.find((c) => c.name === r.call)
          : r.total_votes ? r.candidates[0] : r.decided ? { party: r.decided.party } : null;
        if (who?.party === "D" || who?.party === "R") t[who.party]++; else t.none++;
      }
      return t;
    };
    let clips = "", bands = "";
    for (const f of sfeats) {
      const st = byFips[f.id].abbr;
      if (mapped.has(st)) continue;
      const [[x0, y0], [x1, y1]] = path.bounds(f), w = x1 - x0, t = tally(st), n = t.D + t.R + t.none || 1;
      clips += `<clipPath id="clip-${st}"><path d="${path(f)}"/></clipPath>`;
      let x = x0;
      const band = (cnt, fill) => { if (!cnt) return ""; const bw = (w * cnt) / n; const out = `<rect x="${x}" y="${y0}" width="${bw + 0.3}" height="${y1 - y0}" style="fill:${fill}"/>`; x += bw; return out; };
      bands += `<g clip-path="url(#clip-${st})" class="bands${selected && selected !== st ? " dim" : ""}" data-k="S:${st}">${band(t.D, "var(--dem)")}${band(t.none, "var(--map-blank)")}${band(t.R, "var(--rep)")}</g>`;
    }
    const districts = dfeats.filter((f) => mapped.has(f.id.slice(0, 2))).map((f) => {
      const r = byKey[f.id];
      const cls = selected && selected !== f.id.slice(0, 2) ? " dim" : selectedDist && selectedDist !== "H-" + f.id ? " dim2" : "";
      return `<path data-k="${f.id}" class="dist${cls}" d="${path(f)}" style="fill:${raceFill(r)}"/>`;
    }).join("");
    const mesh = path(topojson.mesh(stopo, stopo.objects.states, (a, b) => a !== b));
    const outline = path(topojson.mesh(stopo, stopo.objects.states, (a, b) => a === b));
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="usmap housegeo${selected ? " zoomed" : ""}" role="img"
        aria-label="House districts on a map; the list below has the same results">
      ${defs()}<defs>${clips}</defs><g class="world">${bands}<g>${districts}</g>
      <path class="smesh" d="${mesh}"/><path class="smesh" d="${outline}"/></g></svg>`;
    const svg = el.querySelector("svg"), world = svg.querySelector(".world");
    const distBy = Object.fromEntries(dfeats.filter((f) => mapped.has(f.id.slice(0, 2))).map((f) => ["H-" + f.id, f]));
    const featFor = (key) => !key ? null : key.startsWith("H-") ? (distBy[key] || featBy[key.slice(2, 4)]) : featBy[key];
    const view = (key) => { const f = featFor(key); return f ? fitTransform(path.bounds(f), key.startsWith("H-") ? 0.55 : 0.9) : IDENTITY; };
    const focusKey = selectedDist || selected || "";
    const focusFeat = featFor(focusKey);
    if (focusFeat) {
      const sp = document.createElementNS(SVGNS, "path");
      sp.setAttribute("d", path(focusFeat));
      sp.setAttribute("class", "hl hl-sel");
      topLayer(svg, world.firstElementChild).appendChild(sp);
    }
    const target = view(focusKey);
    const start = zoomFrom === undefined ? target : view(zoomFrom);
    world.setAttribute("transform", tstr(start));
    if (zoomFrom !== undefined && zoomFrom !== focusKey) {
      flyTo(world, start, target);
    }
    bindTips(svg, (k) => {
      if (k.startsWith("S:")) {
        const st = k.slice(2), t = tally(st);
        const why = newLines.includes(st) ? "New district lines for 2026 aren't mapped yet" : "District lines not loaded";
        return `<b>${esc(byAbbr[st].name)}</b><br>${why}; shaded by seats.<br>${t.D} D leading, ${t.R} R leading, ${t.none} no results`;
      }
      const r = byKey[k];
      return r ? raceTip(r.title, r) : `<b>${esc(k)}</b>`;
    }, (k) => (k.startsWith("S:") ? onPick?.(k.slice(2), null) : onPick?.(k.slice(0, 2), "H-" + k)));
    return { mappedStates: mapped.size, haveDistricts: !!dtopo };
  }

  // ---------------------------------------------------------------- county map inside a race row
  async function countyMap(el, r, stateFips) {
    const topo = await loadGeo("counties");
    const rowNames = new Set((r.counties || []).map((row) => norm(row[0])));
    let feats = topojson.feature(topo, topo.objects.counties).features.filter((f) => f.id.startsWith(stateFips));
    // district or other partial-state races: only the counties the race covers
    const statewide = r.statewide || r.group === "initiative";
    if (!statewide) feats = feats.filter((f) => rowNames.has(norm(f.properties.name)));
    if (!feats.length) { el.textContent = "No county shapes for this race."; return; }
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
      ${!Object.keys(rows).length && (r.status === "no-feed" || r.status === "manual")
        ? `<p class="cmapnote">No county results: this state isn't in a live feed here.</p>` : ""}
      ${!statewide ? `<p class="cmapnote">Counties this race covers. District lines can split counties, so a county here may be only partly in the district.</p>` : ""}
      ${unmatched > 0 ? `<p class="cmapnote">${unmatched} counties in the feed didn't match a map shape.</p>` : ""}`;
    bindTips(el.querySelector("svg"), (name) => countyTip(name, r, rows));
  }

  // ---------------------------------------------------------------- legislative districts (Georgia tab)
  // file: geo/<file>.json with features whose id is the district number; races: that chamber's
  // contests; number(r) gives a race's district number; onPick(race) on click.
  async function districtMap(el, file, races, { number, onPick, label = "District" } = {}) {
    const topo = await loadGeo(file);
    const feats = topojson.feature(topo, topo.objects.districts).features;
    const byNum = {};
    for (const r of races) { const n = number(r); if (n) byNum[n] = r; }
    const CW = 560, CH = 560;
    const proj = d3.geoIdentity().fitExtent([[6, 6], [CW - 6, CH - 6]], { type: "FeatureCollection", features: feats });
    const path = d3.geoPath(proj);
    const shapes = feats.map((f) => {
      const r = byNum[f.id];
      return `<path data-k="${f.id}" class="${r ? "has" : ""}" d="${path(f)}" style="fill:${r ? raceFill(r) : "var(--map-none)"}"/>`;
    }).join("");
    el.innerHTML = `<svg viewBox="0 0 ${CW} ${CH}" class="cmapsvg sldmap" role="img" aria-label="${esc(label)} map; the list below has the same results">${defs()}${shapes}</svg>`;
    const svg = el.querySelector("svg");
    for (const f of feats) if (isFlip(byNum[f.id])) svg.insertAdjacentHTML("beforeend", `<path class="flipover" d="${path(f)}" fill="url(#flip)"/>`);
    bindTips(svg, (k) => { const r = byNum[k]; return r ? raceTip(r.title, r) : `<b>${esc(label)} ${esc(k)}</b><br>Not on this year's ballot or not in the feed`; },
      (k) => byNum[k] && onPick?.(byNum[k]));
    return { districts: feats.length, matched: Object.keys(byNum).length };
  }

  return { usMap, houseGrid, houseGeo, countyMap, districtMap, raceFill, isFlip, partyName };
})();
