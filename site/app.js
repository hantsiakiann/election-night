(() => {
  "use strict";
  const DATA_URL = "data/results.json";
  const PARTY = { D: "var(--dem)", R: "var(--rep)", L: "var(--lib)", G: "var(--grn)" };
  const NEUTRAL = ["var(--np1)", "var(--np2)", "var(--np3)", "var(--np4)", "var(--oth)"];
  const GROUP_NAMES = { senate: "Senate", governor: "Governor", house: "House" };

  const store = {
    get(k, d) { try { const v = localStorage.getItem("en26:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("en26:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const state = {
    data: null, tab: "national", natGroup: store.get("natGroup", "all"), county: store.get("county", null),
    closest: store.get("closest", false), big: store.get("big", false), q: "",
    totals: new Map(), fresh: new Set(), open: new Map(), lastOk: 0, refresh: 60,
  };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n ?? 0).toLocaleString("en-US");
  const pct1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

  // ------------------------------------------------------------------ routing
  function readHash() {
    const [tab, sub] = location.hash.replace(/^#/, "").split("/");
    if (["national", "georgia", "metro"].includes(tab)) state.tab = tab;
    if (tab === "national" && sub) state.natGroup = sub;
    if (tab === "metro" && sub) state.county = decodeURIComponent(sub);
  }
  function writeHash() {
    const sub = state.tab === "national" && state.natGroup !== "all" ? "/" + state.natGroup
      : state.tab === "metro" && state.county ? "/" + encodeURIComponent(state.county) : "";
    history.replaceState(null, "", "#" + state.tab + sub);
  }

  // ------------------------------------------------------------------ race row
  function color(c, i, partisan) {
    return partisan && PARTY[c.party] ? PARTY[c.party] : partisan ? "var(--oth)" : NEUTRAL[i % NEUTRAL.length];
  }
  function barOrder(cands) {
    const d = cands.filter((c) => c.party === "D"), r = cands.filter((c) => c.party === "R");
    const rest = cands.filter((c) => c.party !== "D" && c.party !== "R");
    return d.length && r.length ? [...d, ...rest, ...r] : cands;
  }
  function marginCell(r) {
    if (!r.candidates?.length || !r.total_votes) return `<div class="margin none">${r.status === "no-feed" ? "No feed" : "No votes"}</div>`;
    if (r.margin_pct == null) return `<div class="margin none">${r.vote_for > 1 ? "Elect " + r.vote_for : ""}</div>`;
    if (r.margin_votes === 0) return `<div class="margin tie">Tied</div>`;
    const lead = r.candidates[0];
    let label, cls;
    if (r.measure) { label = `${lead.name} +${pct1(r.margin_pct)}`; cls = "X"; }
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
    const cands = r.candidates || [];
    const partisan = cands.some((c) => c.party);
    const lead = cands[0];
    const leadCls = !r.total_votes ? "" : lead?.party === "D" || lead?.party === "R" ? "lead-" + lead.party : "lead-X";
    const bar = r.total_votes
      ? barOrder(cands.map((c, i) => ({ ...c, _i: i }))).map((c) =>
        `<span style="width:${c.pct}%;background:${color(c, c._i, partisan)}" title="${esc(c.name)} ${pct1(c.pct)}%"></span>`).join("")
      : "";
    const shown = cands.length <= 4 ? cands : cands.slice(0, 3);
    const candHtml = shown.map((c, i) => `
      <span class="cand${i === 0 && r.total_votes ? " leading" : ""}">
        <i class="dot" style="background:${color(c, i, partisan)}"></i>
        <span class="nm">${esc(c.name)}${c.party && c.party !== "D" && c.party !== "R" ? ` (${esc(c.party)})` : ""}</span>
        ${c.incumbent ? '<span class="inc" title="Incumbent">inc.</span>' : ""}
        <span class="pct">${r.total_votes ? pct1(c.pct) + "%" : ""}</span>
        <span class="v">${r.total_votes ? fmt(c.votes) : ""}</span>
      </span>`).join("") + (cands.length > shown.length ? `<span class="cand v">+${cands.length - shown.length} more</span>` : "");

    const flags = [];
    if (r.call) flags.push(`<span class="flag called">Called for ${esc(r.call)}${r.called_by ? ` (${esc(r.called_by)})` : ""}</span>`);
    if (r.below_majority) flags.push(`<span class="flag warn">Leader under 50%: runoff Dec 1 if it holds</span>`);
    if (r.stale) flags.push(`<span class="flag warn">Feed down: showing last numbers received</span>`);
    if (r.status === "manual") flags.push(`<span class="flag">Entered by hand</span>`);
    if (r.vote_for > 1) flags.push(`<span class="flag">Top ${r.vote_for} win</span>`);
    if (r.note) flags.push(`<span class="flag">${esc(r.note)}</span>`);
    if (r.status === "no-feed" || r.status === "not-found" || r.status === "source-error" || r.status === "manual") {
      const href = r.link || r.source_url;
      if (href) flags.push(`<span class="flag"><a href="${esc(href)}" target="_blank" rel="noopener">Official results</a></span>`);
    }
    const sub = r.scope || (r.feed_name && r.feed_name !== r.title && r.group ? r.feed_name : "");
    return `<li class="race ${leadCls}${r.status === "no-feed" ? " nofeed" : ""}${state.fresh.has(r.id) ? " fresh" : ""}" data-id="${esc(r.id)}">
      <div class="race-name">${esc(r.title)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>
      <div class="bar${partisan && cands.some((c) => c.party === "D") && cands.some((c) => c.party === "R") ? "" : " multi"}" role="img"
        aria-label="${esc(cands.map((c) => `${c.name} ${pct1(c.pct)}%`).join(", ") || "No results yet")}">${bar}</div>
      ${marginCell(r)}${inCell(r)}
      ${cands.length ? `<div class="cands">${candHtml}</div>` : ""}
      ${flags.length ? `<div class="flags">${flags.join("")}</div>` : ""}
      <span class="id">${esc(r.id)}</span>
    </li>`;
  }

  // ------------------------------------------------------------------ filtering
  function matches(r) {
    if (!state.q) return true;
    const q = state.q.toLowerCase();
    return [r.title, r.feed_name, r.id, ...(r.candidates || []).map((c) => c.name)].some((s) => s && s.toLowerCase().includes(q));
  }
  function arrange(races) {
    const live = (r) => (r.candidates?.length ? 0 : 1);
    const list = races.filter(matches).map((r, i) => [r, i]).sort((a, b) => live(a[0]) - live(b[0]) || a[1] - b[1]).map((x) => x[0]);
    if (!state.closest) return list;
    const key = (r) => (r.margin_pct == null || !r.total_votes ? 1e9 : Math.abs(r.margin_pct));
    return [...list].sort((a, b) => key(a) - key(b));
  }
  function group(name, races, { collapsible = false, collapsed = false, key = name } = {}) {
    const list = arrange(races);
    if (!list.length) return "";
    const body = `<ul class="races">${list.map(raceRow).join("")}</ul>`;
    const count = `<span class="count">${list.length} ${list.length === 1 ? "race" : "races"}</span>`;
    if (!collapsible) return `<section class="group"><h2>${esc(name)} ${count}</h2>${body}</section>`;
    const open = state.q ? true : state.open.has(key) ? state.open.get(key) : !collapsed;
    return `<details class="group" data-key="${esc(key)}"${open ? " open" : ""}><summary>${esc(name)} ${count}</summary>${body}</details>`;
  }
  const notice = (...lines) => `<div class="notice">${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;

  // ------------------------------------------------------------------ tabs
  function renderNational(d) {
    const groups = Object.keys(d.national || {});
    const pills = ["all", ...groups].map((g) =>
      `<button data-nat="${g}" aria-pressed="${state.natGroup === g}">${g === "all" ? "All" : GROUP_NAMES[g] || g}</button>`).join("");
    const shown = state.natGroup === "all" ? groups : groups.filter((g) => g === state.natGroup);
    return `<div class="subnav" role="group" aria-label="Office">${pills}</div>` +
      shown.map((g) => group(GROUP_NAMES[g] || g, d.national[g])).join("");
  }
  function renderGeorgia(d) {
    if (!d.georgia) return notice("Georgia results aren't flowing yet.",
      "They start once the Secretary of State posts the November 3 election and its ID is set in <code>config/races.yml</code>.");
    return d.georgia.sections.map((s) => group(s.name, s.races, { collapsible: true, collapsed: s.collapsed, key: "ga:" + s.name })).join("");
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
    $("#big").setAttribute("aria-pressed", String(state.big));
    document.documentElement.classList.toggle("big", state.big);
    if (!d) return;
    const html = state.tab === "national" ? renderNational(d) : state.tab === "georgia" ? renderGeorgia(d) : renderMetro(d);
    $("#panel").innerHTML = html.trim() ? html : "";
    if (state.q && !$("#panel .race")) $("#panel").insertAdjacentHTML("beforeend", `<p class="empty-search">No races match “${esc(state.q)}”. Try a last name or a district number.</p>`);
    writeHash();
    renderStatus();
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
    const n = e.target.closest("[data-nat]"), c = e.target.closest("[data-county]");
    if (n) { state.natGroup = n.dataset.nat; store.set("natGroup", state.natGroup); render(); }
    if (c) { state.county = c.dataset.county; store.set("county", state.county); render(); }
  });
  $("#panel").addEventListener("toggle", (e) => {
    const det = e.target;
    if (det.matches?.("details.group") && !state.q) state.open.set(det.dataset.key, det.open);
  }, true);
  $("#closest").addEventListener("click", () => { state.closest = !state.closest; store.set("closest", state.closest); render(); });
  $("#big").addEventListener("click", () => { state.big = !state.big; store.set("big", state.big); render(); });
  let qTimer;
  $("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 120); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); schedule(); } });
  window.addEventListener("hashchange", () => { readHash(); render(); });
  setInterval(renderStatus, 30000);

  readHash();
  render();
  load().then(schedule);
})();
