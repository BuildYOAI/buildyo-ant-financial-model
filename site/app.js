import { runModel, annualize, scenarioParams, LAYOUT } from "./model/engine.js";

const [A, H] = await Promise.all(["data/assumptions.json", "data/historicals.json"].map((u) => fetch(u).then((r) => r.json())));

const SCEN = ["high", "decel", "decline"];
const NAMES = { high: "The Amazon Path", decel: "The Cisco Path", decline: "The AOL Path" };
const BLURB = {
  high: "Everything goes right. Q4'26 growth starts at 40% and fades slowly. Every contract is honored, and new deals after 2027 are sized so supply just keeps pace with demand. Margins dip when a big compute tranche lands ahead of revenue (SpaceXAI in Q1'27), then recover as revenue fills the capacity, the way Amazon grew into its 1999–2001 buildout. Turn up the new-deals slider to see what overbuilding beyond that costs.",
  decel: "Growth fades to low single digits a quarter by 2028. Management responds: the big cloud deals turn out back-loaded, SpaceXAI is cancelled in Q3'27, no new commitments after 2028, and the Google TPU tranche is deferred. Like Cisco after 2000, the company survives and stays solvent but never grows into the valuation.",
  decline: "AOL-style displacement. The product keeps working, but commoditization pushes prices down faster than costs. Revenue peaks in 2027 and erodes. Contract assumptions match the Cisco Path. Once losses set in, management resells idle contracted compute at 45¢ on the dollar, the one lever large enough to matter.",
};
const BIG_CLOUD = ["google_cloud", "amazon_cloud", "microsoft", "lambda", "nscale"];
const SHOCK_QS = ["2027Q1", "2027Q2", "2027Q3", "2027Q4", "2028Q1", "2028Q2", "2028Q3", "2028Q4", "2029Q1"];

const $ = (s, el = document) => el.querySelector(s);
const pctFmt = (v, d = 0) => `${v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`;
const bFmt = (v, d = 1) => `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(d)}B`;
const tFmt = (v) => `$${(v / 1e6).toFixed(2)}T`;
const mFmt = (v) => (v == null || Number.isNaN(v) ? "" : Math.abs(v) < 0.5 ? "–"
  : v < 0 ? `(${Math.round(-v).toLocaleString()})` : Math.round(v).toLocaleString());

// ---------- Controls ----------
// get(p) reads the scenario's preset value; apply(v, ov) writes the override.
const CONTROLS = [
  { g: "Demand", id: "g0", label: "Q4'26 growth vs Q3", min: 0, max: 0.8, step: 0.01, fmt: (v) => pctFmt(v),
    get: (p) => p.demand.g0, apply: (v, o) => (o.demand.g0 = v), hint: "Q3'26 was +45% sequentially" },
  { g: "Demand", id: "decay", label: "How long growth persists", min: 0.3, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2),
    get: (p) => p.demand.decay, apply: (v, o) => (o.demand.decay = v), hint: "Share of each quarter's growth carried into the next" },
  { g: "Demand", id: "floor", label: "Long-run growth per quarter", min: -0.08, max: 0.06, step: 0.005, fmt: (v) => pctFmt(v, 1),
    get: (p) => p.demand.floor, apply: (v, o) => (o.demand.floor = v) },
  { g: "Demand", id: "ceiling", label: "Revenue ceiling (annual run-rate)", min: 100000, max: 1500000, step: 25000, fmt: (v) => `$${Math.round(v / 1000)}B`,
    get: (p) => p.demand.ceilingARR, apply: (v, o) => (o.demand.ceilingARR = v) },
  { g: "Price war", id: "pw", label: "Price-war intensity", min: 0, max: 100, step: 5, fmt: (v) => (v ? `${v} / 100` : "none"),
    get: (p) => p.priceWar?.intensity || 0, apply: (v, o) => (o.priceWar = { intensity: v }), readout: "pw",
    hint: "Prices fall faster than serving costs; usage holds. 100 = a 35% serving margin by Q4'30, about where commodity inference sellers sit today." },
  { g: "Compute commitments", id: "ramp", label: "Big cloud deals: spend ramp", min: 0, max: 24, step: 1,
    fmt: (v) => (v ? `${v} qtrs` : "contract default"),
    get: (p) => p.rampOverrides?.google_cloud || 0,
    apply: (v, o) => (o.rampOverrides = v ? Object.fromEntries(BIG_CLOUD.map((id) => [id, v])) : null),
    hint: "Longer = more back-loaded (Google, Amazon, Microsoft, Lambda, Nscale)" },
  { g: "Compute commitments", id: "spacex", type: "select", label: "Cancel SpaceXAI",
    options: [["", "Keep"], ["2027Q3", "Q3'27 (earliest)"], ["2028Q1", "Q1'28"], ["2029Q1", "Q1'29"]],
    get: (p) => p.cancelSpaceXAI || "", apply: (v, o) => (o.cancelSpaceXAI = v || null), hint: "~$9.3B/qtr at full rate; cancelable on 90 days' notice" },
  { g: "Compute commitments", id: "tpu", label: "Defer Google TPU tranche", min: 0, max: 16, step: 1, fmt: (v) => (v ? `${v} qtrs` : "on schedule"),
    get: (p) => p.deferQuarters?.google_tpu || 0, apply: (v, o) => (o.deferQuarters = { google_tpu: v }), hint: "$125–150B, scheduled from 2028" },
  { g: "Compute commitments", id: "newc", label: "New deal signed each quarter after 2027 (stacks)", min: 0, max: 5000, step: 250,
    fmt: (v) => (v ? `+${bFmt(v, 2)}/qtr` : "none"),
    hint: "Each quarter from 2028 adds another deal of this size on top of the earlier ones, so spending climbs every quarter.",
    get: (p) => p.futureCommit.stepAdd, apply: (v, o) => (o.futureCommit = { stepAdd: v }), readout: "cap" },
  { g: "Compute commitments", id: "spot", label: "Spot compute available", min: 0, max: 0.5, step: 0.05, fmt: (v) => `${Math.round(v * 100)}% of contracted`,
    get: (p) => p.spotCap?.pctOfCommitted ?? 0.15, apply: (v, o) => (o.spotCap = { pctOfCommitted: v }),
    hint: "Extra compute you can buy beyond contracts, at a 20% premium. When demand outruns contracts plus spot, training is squeezed first, then sales are lost." },
  { g: "Management response", id: "resale", type: "check", label: "Resell idle compute",
    get: (p) => !!p.capacityResale?.enabled, apply: (v, o) => (o.capacityResale = { ...(o.capacityResale || {}), enabled: v }), readout: "resale",
    hint: "Starts after two quarters of negative adjusted operating margin. Sells contracted capacity not needed for serving or training. Payroll and G&A cuts aren't modeled: they're small next to compute." },
  { g: "Management response", id: "recovery", label: "Resale price per $ of cost", min: 0.1, max: 0.8, step: 0.05, fmt: (v) => `${Math.round(v * 100)}¢`,
    get: (p) => p.capacityResale?.recoveryPct ?? 0.45, apply: (v, o) => (o.capacityResale = { ...(o.capacityResale || {}), recoveryPct: v }),
    hint: "In a compute glut, buyers pay well below cost" },
  { g: "Shock", id: "shockPct", label: "One-time revenue hit", min: 0, max: 0.4, step: 0.01, fmt: (v) => (v ? `−${pctFmt(v)}` : "none"),
    get: (p) => p.demand.shock?.pct || 0, apply: (v, o, s) => (o.demand.shock = v ? { quarter: s.shockQ, pct: v } : null) },
  { g: "Shock", id: "shockQ", type: "select", label: "…in quarter", options: SHOCK_QS.map((q) => [q, q.replace(/(\d{2})(\d{2})Q(\d)/, "Q$3'$2")]),
    get: (p) => p.demand.shock?.quarter || "2027Q3", apply: () => {} },
  { g: "IPO (same for all paths)", id: "ipoVal", label: "IPO valuation (post-money)", min: 800000, max: 2500000, step: 50000, fmt: tFmt,
    get: (p) => p.ipo.valuation, apply: (v, o) => (o.ipo.valuation = v), shared: true, hint: "Press: $1.5–2T; May round $965B" },
  { g: "IPO (same for all paths)", id: "ipoRaise", label: "IPO raise", min: 25000, max: 150000, step: 5000, fmt: (v) => bFmt(v, 0),
    get: (p) => p.ipo.raise, apply: (v, o) => (o.ipo.raise = v), shared: true, hint: "Press: $100B+; 90% assumed primary" },
  { g: "IPO (same for all paths)", id: "google", type: "check", label: "Google buys $10B at IPO price",
    get: (p) => (p.ipo.googlePlacement || 0) > 0, apply: (v, o) => (o.ipo.googlePlacement = v ? 10000 : 0), shared: true },
];

const state = { scenario: "high", values: {} };

function presetValues(name) {
  const p = scenarioParams(A, name);
  return Object.fromEntries(CONTROLS.map((c) => [c.id, c.get(p)]));
}

function overridesFrom(values) {
  const o = { demand: {}, servingEff: {}, ipo: {} };
  for (const c of CONTROLS) c.apply(values[c.id], o, values);
  return o;
}

function buildControls() {
  const form = $("#controls");
  let fs, lastG;
  for (const c of CONTROLS) {
    if (c.g !== lastG) {
      fs = form.appendChild(document.createElement("fieldset"));
      fs.appendChild(document.createElement("legend")).textContent = c.g;
      lastG = c.g;
    }
    fs.appendChild(controlEl(c, (v) => { state.values[c.id] = v; update(); }));
  }
}

function controlEl(c, onInput) {
  const wrap = document.createElement("div");
  wrap.className = `ctl${c.type === "check" ? " check" : ""}`;
  const lab = document.createElement("label");
  const name = document.createElement("span");
  name.textContent = c.label;
  let input;
  if (c.type === "select") {
    input = document.createElement("select");
    for (const [v, t] of c.options) { const o = input.appendChild(document.createElement("option")); o.value = v; o.textContent = t; }
    input.addEventListener("change", () => onInput(input.value));
    lab.append(name); wrap.append(lab, input);
  } else if (c.type === "check") {
    input = document.createElement("input"); input.type = "checkbox";
    input.addEventListener("change", () => onInput(input.checked));
    lab.append(input, name); wrap.append(lab);
  } else {
    input = document.createElement("input");
    Object.assign(input, { type: "range", min: c.min, max: c.max, step: c.step });
    const out = document.createElement("output");
    input.addEventListener("input", () => { out.textContent = c.fmt(+input.value); onInput(+input.value); });
    lab.append(name, out); wrap.append(lab, input);
    input._out = out;
  }
  input.id = `ctl-${c.id}`;
  input.setAttribute("aria-label", c.label);
  input._ctl = c;
  if (c.hint) { const h = wrap.appendChild(document.createElement("div")); h.className = "hint"; h.textContent = c.hint; }
  if (c.readout) {
    const ro = wrap.appendChild(document.createElement("div"));
    ro.className = "readout"; ro.id = `ro-${c.readout}`; ro.setAttribute("aria-live", "polite");
  }
  return wrap;
}

function syncControls() {
  for (const c of CONTROLS) {
    const el = $(`#ctl-${c.id}`), v = state.values[c.id];
    if (c.type === "check") el.checked = !!v;
    else el.value = v;
    if (el._out) el._out.textContent = c.fmt(+v);
  }
}

// ---------- URL state ----------
function saveHash() {
  const q = new URLSearchParams({ s: state.scenario });
  const preset = presetValues(state.scenario);
  for (const c of CONTROLS) if (state.values[c.id] !== preset[c.id]) q.set(c.id, state.values[c.id]);
  history.replaceState(null, "", `#${q}`);
}

function loadHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const s = q.get("s");
  state.scenario = SCEN.includes(s) ? s : "high";
  state.values = presetValues(state.scenario);
  for (const c of CONTROLS) {
    if (!q.has(c.id)) continue;
    const raw = q.get(c.id);
    state.values[c.id] = c.type === "check" ? raw === "true" : c.type === "select" ? raw : +raw;
  }
}

function selectScenario(name) {
  const shared = Object.fromEntries(CONTROLS.filter((c) => c.shared).map((c) => [c.id, state.values[c.id]]));
  state.scenario = name;
  state.values = { ...presetValues(name), ...shared };
  syncControls();
  update();
}

// ---------- Theme / chart helpers ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const series = (n) => css(`--series-${n}`);
const SCEN_SLOT = { high: 1, decel: 2, decline: 3 };
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, "0");

const forecastBand = {
  id: "forecastBand",
  beforeDatasetsDraw(chart, _a, opt) {
    if (opt?.from == null) return;
    const x = chart.scales.x, { top, bottom, right } = chart.chartArea;
    const step = x.getPixelForValue(1) - x.getPixelForValue(0);
    const x0 = x.getPixelForValue(opt.from) - step / 2;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = alpha(css("--grid"), 0.6);
    ctx.fillRect(x0, top, right - x0, bottom - top);
    ctx.fillStyle = css("--text-muted");
    ctx.font = "11px -apple-system, sans-serif";
    ctx.fillText(opt.label || "Forecast", x0 + 6, top + 12);
    ctx.restore();
  },
};

const endLabels = {
  id: "endLabels",
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    chart.data.datasets.forEach((ds, i) => {
      if (!ds.endLabel || !chart.isDatasetVisible(i)) return;
      const pts = chart.getDatasetMeta(i).data;
      let j = ds.data.length - 1;
      while (j >= 0 && ds.data[j] == null) j--;
      if (j < 0) return;
      ctx.save();
      ctx.fillStyle = css("--text-secondary");
      ctx.font = `${ds.endLabelBold ? 600 : 400} 12px -apple-system, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(ds.endLabel, pts[j].x + 8, pts[j].y);
      ctx.restore();
    });
  },
};
Chart.register(forecastBand, endLabels);

function baseOptions({ yFmt, stacked = false, legend = true, padRight = 0, band = null }) {
  const text2 = css("--text-secondary"), grid = css("--grid");
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: "index", intersect: false },
    layout: { padding: { right: padRight } },
    scales: {
      x: { stacked, grid: { display: false }, ticks: { color: text2, maxRotation: 0, autoSkipPadding: 12 }, border: { color: grid } },
      y: { stacked, grid: { color: grid }, border: { display: false }, ticks: { color: text2, callback: yFmt } },
    },
    plugins: {
      legend: { display: legend, position: "top", align: "start",
        labels: { color: text2, boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2, padding: 14 } },
      tooltip: {
        backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-primary"),
        borderColor: css("--border"), borderWidth: 1, padding: 10, boxWidth: 10, boxHeight: 2, usePointStyle: false,
        callbacks: { label: (c) => (c.raw == null ? null : ` ${yFmt(c.raw)}  ${c.dataset.label}`) },
      },
      forecastBand: band,
    },
  };
}

const charts = {};
function upsert(id, type, data, options) {
  if (charts[id]) { charts[id].data = data; charts[id].options = options; charts[id].update(); return; }
  charts[id] = new Chart(document.getElementById(id), { type, data, options });
}

// ---------- Model runs ----------
let current = {};
function runAll() {
  const shared = Object.fromEntries(CONTROLS.filter((c) => c.shared).map((c) => [c.id, state.values[c.id]]));
  const out = {};
  for (const s of SCEN) {
    const values = s === state.scenario ? state.values : { ...presetValues(s), ...shared };
    const r = runModel(A, H, s, overridesFrom(values));
    out[s] = { r, y: annualize(r, H) };
  }
  return out;
}

// ---------- Renderers ----------
const HQ = H.quarterly_is.periods.slice(0, 6);                 // S-1 quarters
const hq = (k) => H.quarterly_is.lines[k].values.slice(0, 6);

function renderTiles() {
  const { r, y } = current[state.scenario], S = r.series;
  let peakI = 0;
  S.compute.forEach((v, i) => { if (v > S.compute[peakI]) peakI = i; });
  const cumFcf = [2027, 2028, 2029, 2030].reduce((a, k) => a + y[k].fcfAfterLeases, 0);
  const gap = S.fundingGap.reduce((a, b) => a + b, 0);
  const tiles = [
    ["FY2027 revenue", bFmt(y[2027].revenue, 0), `${((y[2027].revenue / y[2026].revenue - 1) * 100).toFixed(0)}% vs FY2026`],
    ["FY2027 adj. operating margin", pctFmt(y[2027].adjOpMargin), `GAAP: ${pctFmt(y[2027].opMargin)}`],
    ["FY2030 revenue", bFmt(y[2030].revenue, 0), `adj. margin ${pctFmt(y[2030].adjOpMargin)}`],
    ["Peak quarterly compute", bFmt(S.compute[peakI], 1), `in ${r.periods[peakI]}`],
    ["FCF after leases, 2027–30", bFmt(cumFcf, 0), "cumulative"],
    gap > 0 ? ["Funding gap by 2030", bFmt(gap, 0), "new equity needed beyond the revolver"]
      : ["Cash, end of 2030", bFmt(y[2030].liquidity, 0), "no funding gap"],
    ["IPO price per share", `$${r.ipo.price.toFixed(2)}`, `notes convert worth ${bFmt(r.ipo.notesValueAtIpo, 0)}`],
  ];
  const root = $("#tiles");
  root.replaceChildren(...tiles.map(([l, v, n]) => {
    const d = document.createElement("div"); d.className = "tile";
    const a = d.appendChild(document.createElement("div")); a.className = "label"; a.textContent = l;
    const b = d.appendChild(document.createElement("div")); b.className = `value${/^[−-]/.test(v) ? " neg" : ""}`; b.textContent = v;
    const c = d.appendChild(document.createElement("div")); c.className = "note"; c.textContent = n;
    return d;
  }));
}

function renderRevenue() {
  const years = [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030];
  const hist = H.annual_is.revenue.slice(0, 3);
  const datasets = [{
    label: "Reported (S-1)", data: [...hist, null, null, null, null, null], borderColor: css("--text-primary"),
    backgroundColor: css("--text-primary"), borderWidth: 2, pointRadius: 4, tension: 0,
  }];
  for (const s of SCEN) {
    const y = current[s].y, sel = s === state.scenario, col = series(SCEN_SLOT[s]);
    datasets.push({
      label: NAMES[s], data: [null, null, hist[2], ...years.slice(3).map((k) => y[k].revenue)],
      borderColor: sel ? col : alpha(col, 0.45), backgroundColor: col, borderWidth: sel ? 3 : 2,
      pointRadius: sel ? 4 : 0, pointHoverRadius: 5, tension: 0,
      endLabel: `${NAMES[s].replace("The ", "")} ${bFmt(y[2030].revenue, 0)}`, endLabelBold: sel,
    });
  }
  const opt = baseOptions({ yFmt: (v) => bFmt(v, 0), padRight: 150 });
  upsert("chRevenue", "line", { labels: years.map((y) => `FY${String(y).slice(2)}`), datasets }, opt);
}

function renderStaircase() {
  const { r } = current[state.scenario], S = r.series;
  const sum = (...ks) => S.revenue.map((_, i) => ks.reduce((a, k) => a + (S[k]?.[i] || 0), 0));
  const groups = [
    ["Pre-2026 cloud minimums", sum("contract_legacy_committed")],
    ["Google (cloud + TPU)", sum("contract_google_cloud", "contract_google_tpu")],
    ["Amazon (AWS)", sum("contract_amazon_cloud")],
    ["Microsoft", sum("contract_microsoft")],
    ["SpaceXAI", sum("contract_spacexai")],
    ["Lambda, Nscale, AMD", sum("contract_lambda", "contract_nscale", "contract_amd")],
    ["Broadcom TPU leases", sum("leaseDepreciation")],
    ["Spot, new deals & own D&A", sum("flexCompute", "contract_future", "ownDepreciation")],
  ];
  if (S.capacityResale.some((v) => v > 0)) groups.push(["Idle capacity resold", S.capacityResale.map((v) => -v), "--neutral-mark"]);
  const surface = css("--surface-1");
  const datasets = groups.map(([label, data, color], i) => ({
    type: "bar", label, data, backgroundColor: color ? css(color) : series(i + 1), borderColor: surface, borderWidth: 1,
    stack: "c", categoryPercentage: 0.85, barPercentage: 0.9, order: 2,
  }));
  datasets.push({ type: "line", label: "Revenue", data: S.revenue, borderColor: css("--text-primary"),
    backgroundColor: css("--text-primary"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, order: 1, stack: "rev" });
  const opt = baseOptions({ yFmt: (v) => bFmt(v, 0), stacked: true });
  opt.scales.y.stacked = true;
  upsert("chStaircase", "bar", { labels: r.periods, datasets }, opt);
}

function renderMargins() {
  // History starts at Q1'26: 2025's −100% to −250% margins would flatten the forecast zigzag to a line.
  const { r } = current[state.scenario], S = r.series, from = 4;
  const labels = [...HQ.slice(from), ...r.periods];
  const rev = hq("revenue").slice(from), oi = hq("operating_income").slice(from), adj = hq("adj_operating_income").slice(from);
  const mk = (label, slot, hist, fc) => ({ label, data: [...hist, ...fc], borderColor: series(slot), backgroundColor: series(slot),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: false });
  const datasets = [
    mk("Adjusted operating margin", 1, adj.map((v, i) => v / rev[i]), S.adjOpMargin),
    mk("GAAP operating margin", 2, oi.map((v, i) => v / rev[i]), S.opMargin),
    mk("Gross margin (serving compute only)", 3, rev.map(() => null), S.grossMargin),
  ];
  const opt = baseOptions({ yFmt: (v) => pctFmt(v), band: { from: rev.length + 1, label: "Forecast" } });
  upsert("chMargins", "line", { labels, datasets }, opt);
}

function renderCash() {
  const { r } = current[state.scenario], S = r.series;
  const datasets = [
    { label: "Cash from operations", data: S.cfo, backgroundColor: series(1) },
    { label: "Free cash flow after lease repayments", data: S.fcfAfterLeases, backgroundColor: series(2) },
  ].map((d) => ({ ...d, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.8, barPercentage: 0.9 }));
  upsert("chCash", "bar", { labels: r.periods, datasets }, baseOptions({ yFmt: (v) => bFmt(v, 0) }));
}

function renderLiquidity() {
  const { r } = current[state.scenario], S = r.series;
  let cum = 0;
  const gapCum = S.fundingGap.map((g) => (cum += g));
  const datasets = [
    { type: "line", label: "Cash & short-term investments", data: S.liquidity, borderColor: series(1), backgroundColor: series(1),
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, order: 1 },
    { type: "line", label: "Revolver drawn", data: S.revolver, borderColor: series(4), backgroundColor: series(4),
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, order: 1 },
  ];
  if (cum > 0) datasets.push({ type: "bar", label: "Funding gap, cumulative", data: gapCum, backgroundColor: css("--critical"),
    borderRadius: 4, borderSkipped: false, order: 2 });
  upsert("chLiquidity", "bar", { labels: r.periods, datasets }, baseOptions({ yFmt: (v) => bFmt(v, 0) }));
}


// ---------- Statements table ----------
const tbl = { stmt: "income", view: "quarterly" };
const IS_MAP = { revenue: "revenue", compute: "compute", personnel: "personnel", salesMarketing: "sales_marketing",
  otherOpex: "other_opex", totalOpex: "total_opex", operatingIncome: "operating_income", interestIncome: "interest_income",
  fvMarkNotes: "fv_change_notes", otherIncome: "other_income", pretaxIncome: "pretax_income", tax: "tax", netIncome: "net_income",
  sbc: "sbc", noncashCharity: "noncash_charity", adjOperatingIncome: "adj_operating_income" };

function bsCol(j) {
  const b = H.balance_sheet, g = (k) => b[k][j];
  return { liquidity: g("cash") + g("st_investments"), accountsReceivable: g("accounts_receivable"), ppeNet: g("ppe_net"),
    leaseAsset: 0, otherAssets: g("prepaid_other_current") + g("restricted_cash") + g("rou_assets") + g("goodwill") + g("other_noncurrent_assets"),
    totalAssets: g("total_assets"), apAccrued: g("ap_accrued"), deferredRevenue: g("deferred_revenue"), leaseLiability: 0, revolver: 0,
    convertibleNotes: g("convertible_notes"), otherLiabilities: g("lease_liab_current") + g("lease_liab_noncurrent") + g("other_noncurrent_liabilities"),
    preferred: g("redeemable_preferred"), equity: g("total_stockholders_deficit"), totalLiabEq: g("total_assets") };
}
function cfCol(j) {
  const c = H.cash_flow, g = (k) => c[k][j];
  const capex = -g("capex"), otherInv = g("other_investing"), cfi = -capex + otherInv;
  const v = { netIncome: g("net_income"), noncashComp: g("sbc") + g("donation_matching"), dAndA: g("d_and_a"),
    fvAddback: g("fv_change_notes") + g("other_fin_instruments"),
    wcChange: g("chg_ar") + g("chg_prepaid_other") + g("chg_ap_accrued") + g("chg_leases") + g("chg_deferred_rev") + g("other_noncash"),
    cfo: g("cfo"), capex, otherInvesting: otherInv, cfi, leasePrincipal: -g("finance_lease_principal"), revolverDraw: 0, cff: g("cff") };
  v.equityProceeds = v.cff + v.leasePrincipal;
  v.netCashChange = v.cfo + v.cfi + v.cff; v.fcf = v.cfo - capex; v.fcfAfterLeases = v.fcf - v.leasePrincipal; v.fundingGap = 0;
  return v;
}
function isCol(src, j) {
  const v = {};
  for (const [k, hk] of Object.entries(IS_MAP)) v[k] = src[hk]?.[j];
  return v;
}

function statementColumns() {
  const { r, y } = current[state.scenario], S = r.series;
  const fq = (i) => Object.fromEntries(Object.keys(S).map((k) => [k, S[k][i]]));
  const cols = [];
  const { stmt, view } = tbl;
  if (view === "quarterly") {
    if (stmt === "income") {
      const L = H.quarterly_is.lines, src = Object.fromEntries(Object.keys(L).map((k) => [k, L[k].values]));
      HQ.forEach((q, j) => cols.push({ label: q, v: isCol(src, j), kind: "s1" }));
    } else if (stmt === "balance") cols.push({ label: "Jun 30 '26", v: bsCol(2), kind: "s1" });
    else cols.push({ label: "H1'26", v: cfCol(H.cash_flow.periods.indexOf("H1'26")), kind: "s1" });
    for (let i = 0; i < 6; i++) cols.push({ label: i === 0 ? `${r.periods[i]}e` : r.periods[i], v: fq(i), kind: i === 0 ? "q3" : "fc" });
  } else {
    if (stmt === "income") {
      const a = H.annual_is, fn = H.functional_opex;
      [0, 1, 2].forEach((j) => {
        const v = isCol(a, j);
        v.servingCompute = fn.cost_of_revenue[j]; v.trainingCompute = a.compute[j] - fn.cost_of_revenue[j];
        v.sbc = H.cash_flow.sbc[j];
        cols.push({ label: a.periods[j], v, kind: "s1" });
      });
    } else if (stmt === "balance") [0, 1].forEach((j) => cols.push({ label: H.balance_sheet.periods[j], v: bsCol(j), kind: "s1" }));
    else [0, 1, 2].forEach((j) => cols.push({ label: H.cash_flow.periods[j], v: cfCol(j), kind: "s1" }));
    for (const k of [2026, 2027, 2028, 2029, 2030]) cols.push({ label: k === 2026 ? "FY26 (H1 actual)" : `FY${String(k).slice(2)}`, v: y[k], kind: "fc" });
  }
  return cols;
}

function renderTable() {
  const cols = statementColumns(), rows = LAYOUT[tbl.stmt];
  const q3flags = H.quarterly_is.lines;
  const t = $("#stmt");
  const thead = document.createElement("thead"), hr = thead.insertRow();
  hr.appendChild(document.createElement("th")).textContent = "$ millions";
  for (const c of cols) { const th = hr.appendChild(document.createElement("th")); th.textContent = c.label; if (c.kind !== "s1") th.className = "fc"; }
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = tbody.insertRow();
    if (row.kind) tr.className = row.kind;
    tr.insertCell().textContent = row.label.trim();
    for (const c of cols) {
      const td = tr.insertCell();
      const raw = c.v?.[row.k];
      td.textContent = raw == null ? (c.kind === "s1" ? "" : "–") : mFmt(raw * (row.sign || 1));
      if (c.kind === "q3") {
        const hk = IS_MAP[row.k], f = tbl.stmt === "income" && hk ? q3flags[hk]?.flags[6] : "est";
        if (f === "press") td.className = "press"; else if (f === "est" || f === "n/e") td.className = "est";
      }
    }
  }
  t.replaceChildren(thead, tbody);
}

// ---------- Live readouts under the price-war and resale controls ----------
function renderReadouts() {
  const { r, y } = current[state.scenario], S = r.series, pw = r.priceWar;
  const pwEl = $("#ro-pw");
  if (pwEl) {
    let txt = `Serving margin by Q4'30: ${pctFmt(S.grossMargin.at(-1))}`;
    if (pw.priceCutPerQ > 0) {
      const base = annualize(runModel(A, H, state.scenario, overridesFrom({ ...state.values, pw: 0 })), H);
      txt += ` (vs ${pctFmt(pw.baseServingMarginEnd)} with no price war). Extra price cut ${pctFmt(pw.priceCutPerQ, 1)} a quarter; ` +
        `FY30 revenue ${bFmt(y[2030].revenue, 0)} vs ${bFmt(base[2030].revenue, 0)}.`;
    } else txt += " (preset path).";
    pwEl.textContent = txt;
  }
  const capEl = $("#ro-cap");
  if (capEl) {
    const yrs = [2027, 2028, 2029, 2030], sum = (k) => yrs.reduce((a, x) => a + y[x][k], 0);
    const runRate = S.contract_future.at(-1);
    capEl.textContent = (runRate > 0 ? `New deals reach ${bFmt(runRate, 1)}/qtr of spending by Q4'30. ` : "") +
      `2027–30: revenue lost to capacity limits ${bFmt(sum("lostRevenue"), 0)}; contracted compute left idle ${bFmt(sum("idleCompute"), 0)}.`;
  }
  const rsEl = $("#ro-resale");
  if (rsEl) {
    const rec = [2027, 2028, 2029, 2030].reduce((a, k) => a + y[k].capacityResale, 0);
    rsEl.textContent = !r.capacityResale.enabled ? "Off on this path."
      : r.capacityResale.startsAt ? `Starts ${r.capacityResale.startsAt}; recovers ${bFmt(rec, 0)} over 2027–30.`
      : "On, but never triggered: adjusted margin never stays negative.";
  }
}

// ---------- Main update ----------
function update() {
  current = runAll();
  renderReadouts();
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.scenario === state.scenario)));
  $("#scenarioBlurb").textContent = BLURB[state.scenario];
  renderTiles(); renderRevenue(); renderStaircase(); renderMargins(); renderCash(); renderLiquidity(); renderTable();
  saveHash();
}

buildControls();
loadHash();
syncControls();
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => selectScenario(b.dataset.scenario)));
$("#resetBtn").addEventListener("click", () => selectScenario(state.scenario));
document.querySelectorAll("[data-stmt]").forEach((b) => b.addEventListener("click", () => {
  tbl.stmt = b.dataset.stmt; document.querySelectorAll("[data-stmt]").forEach((x) => x.classList.toggle("on", x === b)); renderTable();
}));
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
  tbl.view = b.dataset.view; document.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x === b)); renderTable();
}));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
  update();
});
update();
