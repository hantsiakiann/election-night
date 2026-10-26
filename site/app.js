(() => {
  "use strict";
  const DATA_URL = "data/results.json";
  const PARTY = { D: "var(--dem)", R: "var(--rep)", L: "var(--lib)", G: "var(--grn)", I: "var(--ind)", C: "var(--con)", WF: "var(--wf)" };
  const NEUTRAL = ["var(--np1)", "var(--np2)", "var(--np3)", "var(--np4)", "var(--oth)"];
  const GROUP_NAMES = { senate: "Senate", governor: "Governor", house: "House" };
  const NAT_ORDER = ["senate", "house", "governor"];
  const GA_TABS = { statewide: "Statewide", senate: "State Senate", house: "State House" };
  const PARTY_NAME = { D: "Democrat", R: "Republican", L: "Libertarian", G: "Green", I: "Independent", C: "Constitution", WF: "Working Families" };
  const partyName = (p) => PARTY_NAME[p] || p || "";
  // Before votes arrive: Democrat and Republican first, other parties next, independents last.
  const PRE_RANK = (p) => (p === "D" ? 0 : p === "R" ? 1 : p === "I" ? 3 : 2);
  function orderCands(r) {
    const list = (r.candidates || []).map((c, i) => ({ ...c, _o: i }));
    return r.total_votes
      ? list.sort((a, b) => b.votes - a.votes || a._o - b._o)
      : list.sort((a, b) => PRE_RANK(a.party) - PRE_RANK(b.party) || a._o - b._o);
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem("en26:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("en26:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const state = {
    data: null, tab: "national", natGroup: store.get("natGroup", "senate"), county: store.get("county", null), gaTab: "statewide",
    scope: store.get("scope", { senate: "all", governor: "all", house: "key" }), pick: null,
    houseView: store.get("houseView", "grid"), pickDist: null,
    senView: store.get("senView", "up"),
    cmapOpen: new Set(), cmapClosed: new Set(), raceIndex: new Map(),
    closest: store.get("closest", false), theme: store.get("theme", null), q: "",
    totals: new Map(), fresh: new Set(), open: new Map(), lastOk: 0, refresh: 60,
  };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n ?? 0).toLocaleString("en-US");
  const pct1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

  // ------------------------------------------------------------------ routing
  function readHash() {
    if (!location.hash.replace(/^#/, "")) { state.tab = "national"; state.natGroup = "senate"; return; }  // default view
    const [tab, sub] = location.hash.replace(/^#/, "").split("/");
    if (["national", "initiatives", "georgia", "metro"].includes(tab)) state.tab = tab;
    if (tab === "national" && sub && GROUP_NAMES[sub]) state.natGroup = sub;
    if (tab === "metro" && sub) state.county = decodeURIComponent(sub);
    if (tab === "georgia") state.gaTab = GA_TABS[sub] ? sub : "statewide";
  }
  function writeHash() {
    const sub = state.tab === "national" ? "/" + state.natGroup
      : state.tab === "metro" && state.county ? "/" + encodeURIComponent(state.county)
      : state.tab === "georgia" && state.gaTab !== "statewide" ? "/" + state.gaTab : "";
    history.replaceState(null, "", "#" + state.tab + sub);
  }

  // ------------------------------------------------------------------ race row
  const MEASURE = { yes: "var(--yes)", for: "var(--yes)", no: "var(--no)", against: "var(--no)" };
  function color(c, i, partisan) {
    const m = MEASURE[(c.name || "").trim().toLowerCase()];
    if (m) return m;
    return partisan && PARTY[c.party] ? PARTY[c.party] : partisan ? "var(--oth)" : NEUTRAL[i % NEUTRAL.length];
  }
  const yesNo = (c) => MEASURE[(c?.name || "").trim().toLowerCase()];
  function barOrder(cands) {
    if (cands.every(yesNo)) return [...cands].sort((a, b) => (yesNo(a) === "var(--yes)" ? 0 : 1) - (yesNo(b) === "var(--yes)" ? 0 : 1));
    const d = cands.filter((c) => c.party === "D"), r = cands.filter((c) => c.party === "R");
    const rest = cands.filter((c) => c.party !== "D" && c.party !== "R");
    return d.length && r.length ? [...d, ...rest, ...r] : cands;
  }
  function marginCell(r) {
    if (r.decided && !r.total_votes) {
      const p = r.decided.party;
      return `<div class="margin ${p === "D" || p === "R" ? p : "X"} small">${r.decided.winner ? "Unopposed" : `${p} seat`}</div>`;
    }
    if (!r.candidates?.length || !r.total_votes) return `<div class="margin none">${r.status === "no-feed" ? "No feed" : "No votes"}</div>`;
    if (r.margin_pct == null) return `<div class="margin none">${r.vote_for > 1 ? "Elect " + r.vote_for : ""}</div>`;
    if (r.margin_votes === 0) return `<div class="margin tie">Tied</div>`;
    const lead = r.candidates[0];
    let label, cls;
    if (r.measure) { label = `${lead.name} +${pct1(r.margin_pct)}`; cls = yesNo(lead) === "var(--yes)" ? "yes" : yesNo(lead) ? "no" : "X"; }
    else if (lead.party === "D" || lead.party === "R") { label = `${lead.party}+${pct1(r.margin_pct)}`; cls = lead.party; }
    else { label = `${lead.name.split(" ").pop()} +${pct1(r.margin_pct)}`; cls = "X"; }
    return `<div class="margin ${cls}" title="${esc(lead.name)} leads by ${fmt(r.margin_votes)} votes">${esc(label)}</div>`;
  }
  function inCell(r) {
    if (r.reporting_pct == null) return `<div class="in">${r.total_votes ? fmt(r.total_votes) + "<br>votes" : ""}</div>`;
    const pr = r.precincts_total ? `${fmt(r.precincts_reporting)} of ${fmt(r.precincts_total)} precincts reporting (partial counts included)` : "Share reported";
    return `<div class="in" title="${esc(pr)}"><b>${Math.round(r.reporting_pct)}%</b>in</div>`;
  }
  function raceRow(r) {
    const cands = orderCands(r);
    const partisan = cands.some((c) => c.party);
    const lead = cands[0];
    const leadCls = !r.total_votes ? (r.decided ? "lead-" + r.decided.party : "")
      : yesNo(lead) ? (yesNo(lead) === "var(--yes)" ? "lead-yes" : "lead-no")
      : lead?.party === "D" || lead?.party === "R" ? "lead-" + lead.party : "lead-X";
    const bar = r.total_votes
      ? barOrder(cands.map((c, i) => ({ ...c, _i: i }))).map((c) =>
        `<span style="width:${c.pct}%;background:${color(c, c._i, partisan)}" title="${esc(c.name)} ${pct1(c.pct)}%"></span>`).join("")
      : "";
    const shown = cands.length <= 6 ? cands : cands.slice(0, 5);
    const candHtml = shown.map((c, i) => `
      <li class="cand">
        <i class="dot" style="background:${color(c, i, partisan)}"></i>
        <span class="nm">${esc(c.name)}${c.incumbent ? ' <span class="inc" title="Incumbent">inc.</span>' : ""}</span>
        <span class="pty">${esc(partyName(c.party))}</span>
        <span class="v">${r.total_votes ? `${fmt(c.votes)} votes` : ""}</span>
        <span class="pct">${r.total_votes ? pct1(c.pct) + "%" : ""}</span>
      </li>`).join("") + (cands.length > shown.length ? `<li class="cand more">+${cands.length - shown.length} more candidates</li>` : "");

    const flags = [];
    if (r.call) flags.push(`<span class="flag called">Called for ${esc(r.call)}${r.called_by ? ` (${esc(r.called_by)})` : ""}</span>`);
    if (r.below_majority) flags.push(`<span class="flag warn">Leader under 50%: runoff Dec 1 if it holds</span>`);
    if (r.stale) flags.push(`<span class="flag warn">Feed down: showing last numbers received</span>`);
    if (r.status === "manual") flags.push(`<span class="flag">Entered by hand</span>`);
    if (r.needs) flags.push(`<span class="flag">Needs ${esc(r.needs)} to pass</span>`);
    if (r.vote_for > 1) flags.push(`<span class="flag">Top ${r.vote_for} win</span>`);
    if (r.decided) flags.push(`<span class="flag called">${r.decided.winner ? `${esc(r.decided.winner)} (${esc(r.decided.party)}) is unopposed` : esc(r.decided.reason)}</span>`);
    if (r.held === "D" || r.held === "R") flags.push(`<span class="flag held ${r.held}">Now held by ${r.held === "D" ? "Democrats" : "Republicans"}</span>`);
    if (window.ENMaps?.isFlip(r)) flags.push(`<span class="flag flip">Flip from ${r.held === "D" ? "Democrats" : "Republicans"}</span>`);
    if (r.ratings) {
      const asOf = state.data?.summary?.ratings_as_of || {};
      const tip = Object.keys(r.ratings).map((k) => `${k}: ${(asOf[`${k} ${r.group}`] || "").replace(/ at .*/, "")}`).join("; ");
      flags.push(`<span class="flag rating" title="Pre-election ratings, via 270toWin (${esc(tip)})">${Object.entries(r.ratings).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</span>`);
    }
    if (r.note) flags.push(`<span class="flag">${esc(r.note)}</span>`);
    if (r.status === "no-feed" || r.status === "not-found" || r.status === "source-error" || r.status === "manual") {
      const href = r.link || r.source_url;
      if (href) flags.push(`<span class="flag"><a href="${esc(href)}" target="_blank" rel="noopener">Official results</a></span>`);
    }
    const hasCmap = (r.counties?.length > 1 || r.group === "initiative") && r.county_state;
    const cmapShown = hasCmap && state.cmapOpen.has(r.id);
    if (hasCmap) flags.push(`<button class="flag btn" data-cmap-toggle="${esc(r.id)}" aria-expanded="${cmapShown}">${cmapShown ? "Hide" : "Show"} county map</button>`);
    if (cmapShown) state.raceIndex.set(r.id, r);
    const sub = r.subtitle || "";
    return `<li class="race ${leadCls}${r.status === "no-feed" ? " nofeed" : ""}${state.fresh.has(r.id) ? " fresh" : ""}" data-id="${esc(r.id)}">
      <div class="race-name">${esc(r.title)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>
      <div class="bar${partisan && cands.some((c) => c.party === "D") && cands.some((c) => c.party === "R") ? "" : " multi"}" role="img"
        aria-label="${esc(cands.map((c) => `${c.name} ${pct1(c.pct)}%`).join(", ") || "No results yet")}">${bar}</div>
      ${marginCell(r)}${inCell(r)}
      ${r.yes_means ? `<p class="yesmeans"><b>Yes:</b> ${esc(r.yes_means)}</p>` : ""}
      ${cands.length ? `<ol class="cands">${candHtml}</ol>` : ""}
      ${flags.length ? `<div class="flags">${flags.join("")}</div>` : ""}
      ${cmapShown ? `<div class="cmap" data-cmap="${esc(r.id)}"><p class="cmapnote">Loading county map…</p></div>` : ""}
      <span class="id">${esc(r.id)}</span>
    </li>`;
  }

  // ------------------------------------------------------------------ filtering
  function matches(r) {
    if (!state.q) return true;
    const q = state.q.toLowerCase();
    return [r.title, r.feed_name, r.id, r.state_name, r.subtitle, ...(r.candidates || []).map((c) => c.name)]
      .some((s) => s && s.toLowerCase().includes(q)) || (r.state && r.state.toLowerCase() === q);
  }
  function arrange(races) {
    const live = (r) => (r.candidates?.length ? 0 : 1);
    const list = races.filter(matches).map((r, i) => [r, i]).sort((a, b) => live(a[0]) - live(b[0]) || a[1] - b[1]).map((x) => x[0]);
    if (!state.closest) return list;
    const key = (r) => (r.margin_pct == null || !r.total_votes ? 1e9 : Math.abs(r.margin_pct));
    return [...list].sort((a, b) => key(a) - key(b));
  }
  function group(name, races, { collapsible = false, collapsed = false, key = name, unit = "race" } = {}) {
    const list = arrange(races);
    if (!list.length) return "";
    const body = `<ul class="races">${list.map(raceRow).join("")}</ul>`;
    const count = `<span class="count">${list.length} ${unit}${list.length === 1 ? "" : "s"}</span>`;
    if (!collapsible) return `<section class="group"><h2>${esc(name)} ${count}</h2>${body}</section>`;
    const open = state.q ? true : state.open.has(key) ? state.open.get(key) : !collapsed;
    return `<details class="group" data-key="${esc(key)}"${open ? " open" : ""}><summary>${esc(name)} ${count}</summary>${body}</details>`;
  }
  const notice = (...lines) => `<div class="notice">${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;

  // ------------------------------------------------------------------ tabs
  function tally(races) {
    const t = { D: 0, R: 0, O: 0, none: 0 };
    for (const r of races) {
      const who = r.call ? r.candidates.find((c) => c.name === r.call)
        : r.total_votes ? r.candidates[0] : r.decided ? { party: r.decided.party } : null;
      if (!who) t.none++; else if (who.party === "D" || who.party === "R") t[who.party]++; else t.O++;
    }
    return t;
  }
  function balanceBar(g, races, summary) {
    const t = tally(races);
    const hold = summary[g + "_holdovers"] || {};
    const hD = hold.D || 0, hR = hold.R || 0;
    const total = races.length + hD + hR;
    const need = g === "senate" ? summary.senate_control || 51 : g === "house" ? summary.house_control || 218 : null;
    const seg = (n, cls, label) => n ? `<span class="${cls}" style="flex-grow:${n}" title="${label}: ${n}"></span>` : "";
    const word = g === "governor" ? "governorships" : "seats";
    return `<div class="balance">
      <div class="balance-nums"><span class="D"><b>${hD + t.D}</b> Democrats${hD ? ` (${hD} not up)` : ""}</span>
        ${t.O ? `<span class="O"><b>${t.O}</b> other</span>` : ""}
        <span class="R">Republicans <b>${hR + t.R}</b>${hR ? ` (${hR} not up)` : ""}</span></div>
      <div class="balance-bar" role="img" aria-label="${hD + t.D} Democratic, ${hR + t.R} Republican, ${t.none} without results, of ${total} ${word}">
        ${seg(hD, "hD", "Democratic seats not up")}${seg(t.D, "D", "Democrats leading or called")}${seg(t.O, "O", "Others leading")}
        ${seg(t.none, "none", "No results yet")}${seg(t.R, "R", "Republicans leading or called")}${seg(hR, "hR", "Republican seats not up")}
        ${need ? `<i class="mark" style="left:${(100 * need) / total}%"></i>` : ""}
      </div>
      <p class="balance-note">${need ? `${need} ${word} for a majority${g === "senate" ? "; Republicans need 50 with the vice president's tiebreak" : ""}. ` : ""}Counts leaders in races with votes counted, plus races called or settled before Election Day. ${t.none} of ${races.length} races have no results yet.</p>
    </div>`;
  }
  function renderNational(d) {
    const groups = Object.keys(d.national || {}).sort((a, b) => NAT_ORDER.indexOf(a) - NAT_ORDER.indexOf(b));
    if (!groups.includes(state.natGroup)) state.natGroup = groups[0];
    const g = state.natGroup, all = d.national[g] || [];
    const keyCount = all.filter((r) => r.key).length;
    const scope = state.scope[g] || "all";
    const pills = groups.map((x) => `<button data-nat="${x}" aria-pressed="${g === x}">${GROUP_NAMES[x] || x}</button>`).join("");
    const scopes = `<div class="scope" role="group" aria-label="Which races">
      <button data-scope="key" aria-pressed="${scope === "key"}">Key races (${keyCount})</button>
      <button data-scope="all" aria-pressed="${scope === "all"}">All ${all.length}</button></div>`;
    let list = scope === "key" && !state.pick ? all.filter((r) => r.key) : all;
    let pickChip = "";
    if (state.pick) {
      list = list.filter((r) => r.state === state.pick && (!state.pickDist || r.id === state.pickDist));
      const nm = d.states.find((s) => s.abbr === state.pick)?.name || state.pick;
      pickChip = `<button class="pick" data-unpick>${esc(nm)} only <span aria-hidden="true">✕</span><span class="sr">Show all states</span></button>`;
    }
    const stName = state.pick && d.states.find((s) => s.abbr === state.pick)?.name;
    const title = state.pickDist ? `House: ${list[0]?.title || state.pickDist}` : state.pick ? `${GROUP_NAMES[g]}: ${stName}` : `${GROUP_NAMES[g]}${scope === "key" ? ": key races" : ""}`;
    return `<div class="subnav" role="group" aria-label="Office">${pills}</div>
      <div class="natmap-wrap">
        ${balanceBar(g, all, d.summary || {})}
        ${g === "senate" ? `<div class="scope viewtoggle" role="group" aria-label="Which Senate seats to color">
          <button data-sview="up" aria-pressed="${state.senView === "up"}">Seats up this year</button>
          <button data-sview="all" aria-pressed="${state.senView === "all"}">All seats</button></div>` : ""}
        ${g === "house" ? `<div class="scope viewtoggle" role="group" aria-label="House map style">
          <button data-hview="grid" aria-pressed="${state.houseView === "grid"}">Equal squares</button>
          <button data-hview="map" aria-pressed="${state.houseView === "map"}">Geographic</button></div>` : ""}
        <div class="mapbox${state.pick && zoomable() ? " zoomed" : ""}">
          <div id="natmap"></div>
          ${state.pick ? `<div class="mapbar">${state.pickDist ? `<button class="mapback" data-unpick>Back to ${esc(stName)}</button>` : ""}
            <button class="mapback" data-unpick-all>Back to U.S. map</button><span class="mapcap" id="mapcap"></span></div>` : ""}
        </div>
        <ul class="legend">
          <li><i style="background:var(--dem)"></i><i style="background:color-mix(in srgb, var(--dem) 55%, var(--map-blank))"></i>Democrat leads (lighter = closer)</li>
          <li><i style="background:var(--rep)"></i><i style="background:color-mix(in srgb, var(--rep) 55%, var(--map-blank))"></i>Republican leads</li>
          <li><i style="background:var(--map-blank)"></i>No results yet</li>
          ${g === "house" ? "" : `<li><i class="flipsw"></i>Striped: seat would flip</li>
          ${g === "senate" && state.senView === "up" ? `<li><i style="background:var(--map-none)"></i>No Senate race this year</li>`
            : `<li><i style="background:var(--dem)"></i><i style="background:var(--rep)"></i>${g === "senate" ? '<i style="background:var(--split)"></i>' : ""}Not up this year: current ${g === "senate" ? "senators (purple = one of each party)" : "governor"}</li>`}`}
          ${g === "house" && state.houseView === "map" ? `<li><i class="bandsw"></i>New 2026 lines, not mapped: shaded by seats each party leads</li>` : ""}
          <li class="hint">${g === "house" ? (state.houseView === "map" ? "Click a state to zoom in, then a district for its results." : "Each square is one district. Click a state, then a district.") : "Click a state to zoom into its counties."}</li>
        </ul>
      </div>
      <div class="listbar">${scopes}${pickChip}</div>` +
      (group(title, list) || notice("No races match."));
  }
  function renderInitiatives(d) {
    const states = d.initiatives?.states || [];
    if (!states.length) return notice("No ballot measures are listed yet.", "Add them in <code>config/initiatives.yml</code>.");
    const html = states.map((s) => group(s.name, s.measures, { unit: "measure" })).join("");
    return (html || (state.q ? "" : notice("No ballot measures match."))) +
      `<p class="cmapnote">Only North Carolina's measures come from a live feed here; the rest show "No feed" with a link to official results unless numbers are entered by hand.</p>`;
  }
  function renderGeorgia(d) {
    const t = state.gaTab || "statewide";
    const pills = `<div class="subnav" role="group" aria-label="Georgia races">${Object.entries(GA_TABS).map(([k, v]) =>
      `<button data-gatab="${k}" aria-pressed="${t === k}">${v}</button>`).join("")}</div>`;
    const cap = t === "statewide" ? "Governor by county" : `${GA_TABS[t]} districts`;
    const mapbox = `<figure class="gamapbox"><div id="gamap" data-gamap="${t}"></div><figcaption class="cmapnote">${cap}</figcaption></figure>`;
    if (!d.georgia) return pills + mapbox + notice("Georgia results aren't flowing yet.",
      "They start once the Secretary of State posts the November 3 election and its ID is set in <code>config/races.yml</code>.");
    const secs = d.georgia.sections.filter((s) => (s.tab || "statewide") === t);
    const body = t === "statewide"
      ? secs.map((s) => group(s.name, s.races, { collapsible: true, collapsed: s.collapsed, key: "ga:" + s.name })).join("")
      : secs.map((s) => group(s.name, s.races)).join("");
    return pills + mapbox + (body || notice(state.q ? "No races here match the search." : `No ${GA_TABS[t]} contests in the feed yet.`));
  }
  function renderMetro(d) {
    if (!d.metro) return notice("Metro Atlanta results come from the same Georgia feed, which isn't flowing yet.");
    const counties = d.metro.counties;
    if (!state.county || !counties.some((c) => c.name === state.county)) state.county = counties[0]?.name;
    const pills = counties.map((c) => `<button data-county="${esc(c.name)}" aria-pressed="${state.county === c.name}">${esc(c.name)}</button>`).join("");
    const c = counties.find((x) => x.name === state.county);
    if (!c) return "";
    if (c.missing) return `<div class="subnav">${pills}</div>` + notice(`${esc(c.name)} County isn't in the state feed yet.`);
    const top = arrange(c.top);
    return `<div class="subnav" role="group" aria-label="County">${pills}</div>` +
      (top.length ? `<section class="group county-top"><h2>How ${esc(c.name)} County is voting</h2><ul class="races">${top.map(raceRow).join("")}</ul></section>` : "") +
      c.sections.map((s) => group(s.name, s.races, { collapsible: true, collapsed: s.collapsed, key: "metro:" + s.name })).join("") +
      (c.sections.length ? "" : notice(`No county or city contests listed for ${esc(c.name)} yet.`));
  }

  function render() {
    const d = state.data;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
    $("#closest").setAttribute("aria-pressed", String(state.closest));
    applyTheme();
    if (!d) return;
    state.raceIndex.clear();
    const html = state.tab === "national" ? renderNational(d) : state.tab === "initiatives" ? renderInitiatives(d)
      : state.tab === "georgia" ? renderGeorgia(d) : renderMetro(d);
    $("#panel").innerHTML = html.trim() ? html : "";
    drawMaps(d);
    alignParties();
    if (state.q && !$("#panel .race")) $("#panel").insertAdjacentHTML("beforeend", `<p class="empty-search">No races match “${esc(state.q)}”. Try a last name or a district number.</p>`);
    writeHash();
    renderStatus();
  }

  // One name-column width for every candidate list on the page, so the party names line up
  // all the way down. Measured at natural width, then fixed (capped; longer names wrap).
  document.fonts?.ready.then(() => alignParties());
  function alignParties() {
    const panel = $("#panel");
    const lists = panel?.querySelectorAll(".cands") || [];
    if (!lists.length) return;
    panel.style.setProperty("--namecol", "max-content");
    let w = 0;
    panel.querySelectorAll(".cand .nm").forEach((n) => { w = Math.max(w, n.getBoundingClientRect().width); });
    const em = parseFloat(getComputedStyle(lists[0]).fontSize) || 14;
    panel.style.setProperty("--namecol", `${Math.min(Math.ceil(w) / em + 0.2, 17).toFixed(2)}em`);
  }

  function drawMaps(d) {
    if (!window.ENMaps || !window.d3 || !window.topojson) return;
    const fail = (el) => (e) => { el.innerHTML = `<p class="cmapnote">Map unavailable (${esc(e.message)}).</p>`; };
    const nat = $("#natmap");
    if (nat) {
      const races = d.national[state.natGroup] || [];
      const held = {}, notUp = {};
      const up = new Set(races.map((r) => r.state));
      races.forEach((r) => { if (r.held) held[r.state] = r.held; });
      if (state.natGroup === "senate" && state.senView === "all") Object.assign(notUp, d.summary?.senate_not_up || {});
      if (state.natGroup === "governor") for (const [st, p] of Object.entries(d.summary?.governor_party || {})) if (!up.has(st)) notUp[st] = p;
      const word = { D: "Democrats", R: "Republicans" };
      const notUpText = (st) => !notUp[st] ? "" : state.natGroup === "senate"
        ? (notUp[st] === "split" ? "One Democratic and one Republican senator" : `Both senators are ${word[notUp[st]]}`)
        : `Governor is a ${notUp[st] === "D" ? "Democrat" : "Republican"}`;
      const anim = state.zoomAnim || {};
      state.zoomAnim = null;
      const opts = { selected: state.pick, held, notUp, notUpText, animate: anim.animate, from: anim.from, onPick: (abbr) => pickState(abbr) };
      const hopts = { selected: state.pick, selectedDist: state.pickDist, zoomFrom: anim.zoomFrom, onPick: (abbr, rid) => pickHouse(abbr, rid) };
      if (state.natGroup === "house" && state.houseView === "map") {
        ENMaps.houseGeo(nat, races, d.states, { ...hopts, newLines: d.summary?.house_new_lines || [] }).then((info) => {
          const cap = $("#mapcap");
          if (cap && state.pick) cap.textContent = state.pickDist ? state.pickDist.slice(2) : `${d.states.find((s) => s.abbr === state.pick)?.name} districts`;
          if (!info.haveDistricts) nat.insertAdjacentHTML("beforeend", `<p class="cmapnote">District lines haven't been built yet (run "Build district map" in GitHub Actions); states are shaded by seats.</p>`);
        }).catch(fail(nat));
      } else if (state.natGroup === "house") ENMaps.houseGrid(nat, races, d.states, hopts).then(() => {
        const cap = $("#mapcap");
        if (cap && state.pick) cap.textContent = state.pickDist ? state.pickDist.slice(2) : `${d.states.find((s) => s.abbr === state.pick)?.name} districts`;
      }).catch(fail(nat));
      else ENMaps.usMap(nat, races, d.states, opts).then((info) => {
        const cap = $("#mapcap");
        if (cap && state.pick) {
          const nm = d.states.find((s) => s.abbr === state.pick)?.name;
          cap.textContent = info.hasCounties ? `${nm} by county` : `${nm}: this state's feed has no county results`;
        }
      }).catch(fail(nat));
    }
    const gm = $("#gamap");
    if (gm) drawGeorgiaMap(gm, d).catch(fail(gm));
    document.querySelectorAll("[data-cmap]").forEach((el) => {
      const r = state.raceIndex.get(el.dataset.cmap);
      const st = d.states.find((s) => s.abbr === r?.county_state);
      if (r && st) ENMaps.countyMap(el, r, st.fips).catch(fail(el));
    });
  }

  // Georgia tab map: counties shaded by the governor's race (statewide), or legislative districts.
  const distNum = (r) => { const m = /District\s*0*(\d+)/i.exec(r.feed_name || r.title || ""); return m ? m[1] : null; };
  async function drawGeorgiaMap(el, d) {
    const t = el.dataset.gamap, secs = (d.georgia?.sections || []);
    if (t === "statewide") {
      const gov = secs.flatMap((s) => s.races).find((r) => /^governor$/i.test((r.feed_name || r.title || "").trim()));
      return ENMaps.countyMap(el, gov || { title: "Governor", candidates: [], counties: [], statewide: true, status: "waiting" }, "13");
    }
    const races = secs.filter((s) => s.tab === t).flatMap((s) => s.races);
    return ENMaps.districtMap(el, t === "senate" ? "ga_sldu" : "ga_sldl", races, {
      number: distNum, label: t === "senate" ? "Senate District" : "House District",
      onPick: (r) => {
        const row = document.querySelector(`.race[data-id="${CSS.escape(r.id)}"]`);
        if (!row) return;
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.remove("fresh"); void row.offsetWidth; row.classList.add("fresh");
      },
    });
  }

  function zoomable() { return state.natGroup !== "house" || state.houseView === "map"; }
  function pickState(abbr) {
    const prev = state.pick;
    if (prev === abbr) return unpick();
    state.pick = abbr;
    state.zoomAnim = zoomable() ? (prev ? { animate: "move", from: prev } : { animate: "in" }) : null;
    render();
  }
  // House: first click picks the state; a click on a district in that state picks the district;
  // clicking the picked district again steps back to the state.
  function pickHouse(abbr, rid) {
    const before = state.pickDist || state.pick || "";
    if (state.pick !== abbr) { state.pick = abbr; state.pickDist = null; }
    else if (!rid) return;
    else state.pickDist = state.pickDist === rid ? null : rid;
    state.zoomAnim = { zoomFrom: before };
    render();
  }
  function unpick() {
    if (!state.pick) return;
    if (state.natGroup === "house") {
      const before = state.pickDist || state.pick;
      if (state.pickDist) state.pickDist = null; else state.pick = null; state.pickDist = null;
      state.zoomAnim = { zoomFrom: before };
      return render();
    }
    state.zoomAnim = zoomable() ? { animate: "out", from: state.pick } : null;
    state.pick = null; state.pickDist = null;
    render();
  }

  function currentTheme() {
    return state.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
  function applyTheme() {
    if (state.theme) document.documentElement.dataset.theme = state.theme;
    else delete document.documentElement.dataset.theme;
    const next = currentTheme() === "dark" ? "Light mode" : "Dark mode";
    $("#theme").textContent = next;
    $("#theme").setAttribute("aria-label", `Switch to ${next.toLowerCase()}`);
  }

  function renderStatus() {
    const d = state.data;
    if (!d) return;
    const gen = new Date(d.generated_at);
    const mins = Math.round((Date.now() - gen) / 60000);
    const time = gen.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("#updated").innerHTML = mins >= 10
      ? `<span class="stale">Last update ${mins} minutes ago (${time}).</span> Numbers may be behind.`
      : `Updated ${time}. Checks for new numbers every ${state.refresh >= 120 ? Math.round(state.refresh / 60) + " minutes" : "minute"}.`;
    $("#sources").innerHTML = Object.entries(d.sources || {}).map(([k, s]) =>
      `<li>${esc(k)}: ${s.ok ? `${s.contests} contests` : `<span class="bad">not responding (${esc(s.error)})</span>`}${s.page ? `, <a href="${esc(s.page)}" target="_blank" rel="noopener">official site</a>` : ""}</li>`).join("");
  }

  // ------------------------------------------------------------------ data
  function* allRaces(d) {
    for (const g of Object.values(d.national || {})) yield* g;
    for (const s of d.georgia?.sections || []) yield* s.races;
    for (const c of d.metro?.counties || []) { yield* c.top || []; for (const s of c.sections || []) yield* s.races; }
  }
  async function load() {
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      if (state.data && d.generated_at === state.data.generated_at) { renderStatus(); return; }
      state.fresh.clear();
      for (const r of allRaces(d)) {
        const before = state.totals.get(r.id);
        if (before !== undefined && r.total_votes > before) state.fresh.add(r.id);
        state.totals.set(r.id, r.total_votes || 0);
      }
      state.data = d;
      state.refresh = Math.max(30, d.refresh_seconds || 60);
      $("#title").textContent = d.title || "Election Night";
      document.title = d.title || document.title;
      render();
    } catch (e) {
      if (!state.data) $("#updated").textContent = "No results file yet. It appears after the first update run.";
      else renderStatus();
    }
  }
  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => { if (!document.hidden) await load(); schedule(); }, state.refresh * 1000);
  }

  // ------------------------------------------------------------------ events
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    state.tab = b.dataset.tab; render(); $("#panel").focus({ preventScroll: true });
  });
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...document.querySelectorAll(".tabs button")];
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    state.tab = next.dataset.tab; render(); next.focus();
  });
  $("#panel").addEventListener("click", (e) => {
    const n = e.target.closest("[data-nat]"), c = e.target.closest("[data-county]"), gt = e.target.closest("[data-gatab]");
    if (gt) { state.gaTab = gt.dataset.gatab; render(); return; }
    const sc = e.target.closest("[data-scope]"), tg = e.target.closest("[data-cmap-toggle]");
    const hv = e.target.closest("[data-hview]"), sv = e.target.closest("[data-sview]");
    if (sv) { state.senView = sv.dataset.sview; store.set("senView", state.senView); render(); return; }
    if (hv) { state.houseView = hv.dataset.hview; store.set("houseView", state.houseView); state.pick = null; state.pickDist = null; render(); return; }
    if (e.target.closest("[data-unpick]")) unpick();
    if (e.target.closest("[data-unpick-all]")) {
      const before = state.pickDist || state.pick;
      state.pickDist = null;
      if (state.natGroup === "house") { state.pick = null; state.pickDist = null; state.zoomAnim = { zoomFrom: before }; render(); } else unpick();
    }
    if (sc) { state.scope = { ...state.scope, [state.natGroup]: sc.dataset.scope }; state.pick = null; state.pickDist = null; store.set("scope", state.scope); render(); }
    if (tg) {
      const id = tg.dataset.cmapToggle, open = tg.getAttribute("aria-expanded") === "true";
      if (open) { state.cmapOpen.delete(id); state.cmapClosed.add(id); } else { state.cmapClosed.delete(id); state.cmapOpen.add(id); }
      render();
    }
    if (n) { state.natGroup = n.dataset.nat; state.pick = null; state.pickDist = null; store.set("natGroup", state.natGroup); render(); }
    if (c) { state.county = c.dataset.county; store.set("county", state.county); render(); }
  });
  $("#panel").addEventListener("toggle", (e) => {
    const det = e.target;
    if (det.matches?.("details.group") && !state.q) state.open.set(det.dataset.key, det.open);
  }, true);
  $("#closest").addEventListener("click", () => { state.closest = !state.closest; store.set("closest", state.closest); render(); });
  $("#theme").addEventListener("click", () => {
    state.theme = currentTheme() === "dark" ? "light" : "dark";
    store.set("theme", state.theme);
    applyTheme();
  });
  let qTimer;
  $("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 120); });
  $("#title").addEventListener("click", (e) => {  // home: Senate, un-zoomed, no filters
    e.preventDefault();
    state.tab = "national"; state.natGroup = "senate"; state.pick = null; state.pickDist = null; state.q = ""; $("#q").value = "";
    store.set("natGroup", "senate");
    render(); scrollTo({ top: 0 });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.tab === "national" && state.pick) unpick(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); schedule(); } });
  window.addEventListener("hashchange", () => { readHash(); render(); });
  setInterval(renderStatus, 30000);

  readHash();
  render();
  load().then(schedule);
})();
