// ANT forecast engine. Pure functions, no I/O, so the same file runs in Node and in the browser.
// $ millions. Quarter index 0 = Q3'26 (calibrated to data/historicals.json); runs quarterly to horizonEnd.

export function qIndex(label) {
  const [y, q] = label.split("Q").map(Number);
  return (y - 2026) * 4 + (q - 3);
}

export function qLabel(i) {
  const n = 2026 * 4 + 2 + i;
  return `Q${(n % 4) + 1}'${String(Math.floor(n / 4)).slice(2)}`;
}

export function qYear(i) {
  return Math.floor((2026 * 4 + 2 + i) / 4);
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export function scenarioParams(assumptions, name, overrides = {}) {
  const s = assumptions.scenarios[name] || {};
  return deepMerge(deepMerge(assumptions.common, s), overrides);
}

// Linear glide from start (index 0) to end (at endQuarter), flat after.
function glide(g, i) {
  const iEnd = qIndex(g.endQuarter);
  return i >= iEnd ? g.end : g.start + ((g.end - g.start) * i) / iEnd;
}

// Quarterly cost of one contract over model indices [0, N).
export function contractSchedule(c, N, cancelAt = null) {
  const out = new Array(N).fill(0);
  if (c.type === "annualSchedule") {
    for (let i = 0; i < N; i++) out[i] = (c.schedule[qYear(i)] || 0) / 4;
    return out;
  }
  const s = qIndex(c.start), e = qIndex(c.end);
  const weight = (k) => {
    if (c.rampProfile) return k < c.rampProfile.length ? c.rampProfile[k] : 1;
    return Math.min(1, (k + 1) / (c.ramp || 1));
  };
  let full = c.fullRate;
  if (full == null) {
    let sumW = 0;
    for (let k = 0; k <= e - s; k++) sumW += weight(k);
    full = c.total / sumW;
  }
  for (let i = Math.max(0, s); i <= Math.min(N - 1, e); i++) {
    if (cancelAt != null && i >= cancelAt) break;
    out[i] = full * weight(i - s);
  }
  return out;
}

const pmt = (pv, r, n) => (pv * r) / (1 - Math.pow(1 + r, -n));

export function runModel(assumptions, hist, scenarioName, overrides = {}) {
  const p = scenarioParams(assumptions, scenarioName, overrides);
  const cal = p.calibration;
  const N = qIndex(p.horizonEnd) + 1;
  const ipoIdx = qIndex(p.ipo.quarter);
  const H = hist.quarterly_is.lines;
  const q3 = (k) => H[k].values[H[k].values.length - 1];  // Q3'26 estimate column
  const bs0 = hist.balance_sheet;
  const last = (k) => bs0[k][bs0[k].length - 1];          // 6/30/26

  // ---- Supply: the staircase ----
  const cancelAt = p.cancelSpaceXAI ? qIndex(p.cancelSpaceXAI) : null;
  const byContract = {};
  const shift = (label, q) => { const i = qIndex(label) + q, n = 2026 * 4 + 2 + i; return `${Math.floor(n / 4)}Q${(n % 4) + 1}`; };
  for (const c of p.contracts.cloud) {
    let cc = c;
    const ramp = p.rampOverrides?.[c.id];
    if (ramp) cc = { ...cc, ramp };
    const defer = p.deferQuarters?.[c.id];
    if (defer) cc = { ...cc, start: shift(cc.start, defer), end: shift(cc.end, defer) };
    byContract[c.id] = contractSchedule(cc, N, c.id === "spacexai" ? cancelAt : null);
  }
  const fc = p.futureCommit, fcStart = qIndex(fc.start);
  byContract.future = Array.from({ length: N }, (_, i) => (i >= fcStart ? fc.stepAdd * (i - fcStart + 1) : 0));

  // Finance leases: cohorts commence, then amortize as annuities
  const fl = p.contracts.financeLeases, rQ = fl.rate / 4;
  const cohorts = Object.entries(fl.commence).map(([q, frac]) => ({
    i: qIndex(q), amt: fl.total * frac, pay: pmt(fl.total * frac, rQ, fl.termQuarters),
  }));

  // ---- Series ----
  const keys = [
    "revenue", "volumeRevenue", "priceIndex", "demandGrowth", "servingEff", "servingCompute", "trainingCompute", "committedCloud", "flexCompute",
    "idleCompute", "capacityResale", "lostRevenue",
    "leaseDepreciation", "ownDepreciation", "compute", "headcount", "personnelCash", "sbc", "personnel",
    "salesMarketing", "otherOpex", "noncashCharity", "totalOpex", "operatingIncome", "adjOperatingIncome",
    "interestIncome", "leaseInterest", "revolverInterest", "fvMarkNotes", "pretaxIncome", "tax", "netIncome",
    "capex", "leaseCommenced", "leasePrincipal", "leasePayments",
    "cfo", "cfi", "cff", "fcf", "fcfAfterLeases", "ipoProceeds", "otherEquityProceeds", "revolverDraw",
    "fundingGap", "liquidity", "accountsReceivable", "deferredRevenue", "apAccrued", "ppeNet", "leaseAsset",
    "leaseLiability", "revolver", "convertibleNotes", "preferred", "equity", "totalAssets", "totalLiabEq",
    "bsCheck", "fdShares", "grossMargin", "adjOpMargin", "opMargin", "computePctRev",
    "otherIncome", "noncashComp", "dAndA", "fvAddback", "wcChange", "otherInvesting", "equityProceeds",
    "netCashChange", "otherAssets", "otherLiabilities",
  ];
  const S = Object.fromEntries(keys.map((k) => [k, new Array(N).fill(0)]));
  for (const id of Object.keys(byContract)) S[`contract_${id}`] = byContract[id];

  // Opening balances (6/30/26)
  const constAssets = last("prepaid_other_current") + last("restricted_cash") + last("rou_assets")
    + last("goodwill") + last("other_noncurrent_assets");
  const constLiabs = last("lease_liab_current") + last("lease_liab_noncurrent") + last("other_noncurrent_liabilities");
  let liq = last("cash") + last("st_investments");
  let ar = last("accounts_receivable"), defRev = last("deferred_revenue"), ap = last("ap_accrued");
  let ppe = last("ppe_net"), leaseAsset = 0, leaseLiab = 0, revolver = 0;
  let notes = last("convertible_notes"), preferred = last("redeemable_preferred");
  let equity = last("total_stockholders_deficit");
  let nol = p.nolStart, fdShares = cal.fdShares;
  let head = cal.q3HeadcountEnd;
  const cashPerHead0 = (q3("personnel") - q3("sbc")) / cal.q3HeadcountEnd;

  // IPO arithmetic (post-money valuation)
  const primary = p.ipo.raise * p.ipo.primaryPct;
  const gPlace = p.ipo.googlePlacement || 0;
  const ipoPrice = (p.ipo.valuation - primary - gPlace) / cal.fdShares;
  const notesAtIpo = cal.notesShares * ipoPrice;
  const catchup = cal.ipoRsuCatchup + cal.postJuneRsuGrants * p.sbc.postJuneCatchupFrac;
  const amortPool = cal.ipoRsuUnrecognized + cal.postJuneRsuGrants * (1 - p.sbc.postJuneCatchupFrac)
    + Math.max(0, cal.otherAwardsUnrecognized - q3("sbc"));
  const nA = p.sbc.postIpoAmortQuarters, wSum = (nA * (nA + 1)) / 2;
  const amdStart = qIndex(p.amdEquity.start);

  // Price war: revenue = volume × price. Serving cost follows volume, so a price cut lowers revenue, not cost.
  // Intensity 0 = no extra price cut (preset path); 100 = serving margin falls to floorMargin by horizonEnd.
  // The extra quarterly price cut is back-solved from that target.
  const pw = p.priceWar || {}, iEnd = N - 1;
  const effEnd = p.servingEff.start * Math.pow(1 + p.servingEff.driftPerQ, iEnd);
  const baseMarginEnd = 1 - 1 / effEnd;
  const pwIntensity = Math.min(100, Math.max(0, pw.intensity || 0)) / 100;
  const pwTargetMargin = baseMarginEnd - (baseMarginEnd - (pw.floorMargin ?? 0.35)) * pwIntensity;
  const priceCut = pwTargetMargin < baseMarginEnd - 1e-9
    ? 1 - Math.pow(1 / ((1 - pwTargetMargin) * effEnd), 1 / iEnd) : 0;

  // Management response: resell idle committed compute once adjusted operating margin stays negative.
  const cr = p.capacityResale || {};
  let lowRun = 0, resaleStart = -1;
  let vol = 0;

  for (let i = 0; i < N; i++) {
    // Revenue = demand volume (in Q3'26 prices) × price index
    if (i === 0) vol = q3("revenue");
    else {
      const d = p.demand;
      let g = d.floor + (d.g0 - d.floor) * Math.pow(d.decay, i - 1);
      if (g > 0) g *= Math.max(0, 1 - (4 * vol) / d.ceilingARR);
      S.demandGrowth[i] = g;
      vol *= 1 + g;
      if (i <= d.policyQuarters) vol *= 1 - d.policyCleanupPct / d.policyQuarters;
      if (d.shock && i === qIndex(d.shock.quarter)) vol *= 1 - d.shock.pct;
    }
    const price = Math.pow(1 - priceCut, i);
    S.volumeRevenue[i] = vol; S.priceIndex[i] = price;

    // Leases this quarter
    let leaseDep = 0, leaseInt = 0, leasePrin = 0, leasePay = 0, commenced = 0;
    for (const c of cohorts) {
      if (i === c.i) commenced += c.amt;
      const k = i - c.i;
      if (k < 0 || k >= fl.termQuarters) continue;
      // balance of this cohort at start of period k (annuity schedule)
      const bal = c.amt * Math.pow(1 + rQ, k) - c.pay * ((Math.pow(1 + rQ, k) - 1) / rQ);
      const int = bal * rQ;
      leaseDep += c.amt / fl.termQuarters;
      leaseInt += int;
      leasePrin += c.pay - int;
      leasePay += c.pay;
    }
    leaseAsset += commenced - leaseDep;
    leaseLiab += commenced - leasePrin;

    // Own equipment depreciation (capex itself follows revenue, below)
    const ownDep = ppe / p.ppeLifeQuarters;

    // Compute: committed staircase + flexible top-up, with spot purchases capped
    const eff = p.servingEff.start * Math.pow(1 + p.servingEff.driftPerQ, i);
    const committedCloud = Object.keys(byContract).reduce((a, id) => a + byContract[id][i], 0);
    const committed = committedCloud + leaseDep + ownDep;
    const tPct = glide(p.trainingPctRev, i);
    // Capacity = contracted compute + spot capped at a share of it. Serving has priority: when capacity is short,
    // training is squeezed down to trainingFloorPct of revenue first; demand beyond that is lost revenue.
    let served = vol, train = tPct * vol * price;
    const cap = p.spotCap?.pctOfCommitted;
    if (i > 0 && cap != null) {
      const C = committed * (1 + cap);
      if (vol / eff + train > C) {
        const tf = Math.min(p.spotCap.trainingFloorPct ?? tPct, tPct);
        if (vol / eff + tf * vol * price <= C) train = C - vol / eff;
        else { served = C / (1 / eff + tf * price); train = tf * served * price; }
      }
    }
    const rev = served * price;
    S.revenue[i] = rev; S.lostRevenue[i] = (vol - served) * price;
    const serving = served / eff;
    const need = serving + train;
    let flex;
    if (i === 0) flex = Math.max(0, q3("compute") - committed);
    else flex = Math.max(0, need - committed) * p.flexPremium;
    const idle = i === 0 ? 0 : Math.max(0, committed - need);
    let resale = 0;
    if (cr.enabled && resaleStart >= 0 && i >= resaleStart) {
      resale = idle * cr.recoveryPct * Math.min(1, (i - resaleStart + 1) / (cr.rampQuarters || 1));
    }
    const compute = committed + flex - resale;
    const capex = p.capexPctRev * rev;
    ppe += capex - ownDep;
    S.idleCompute[i] = idle; S.capacityResale[i] = resale;
    S.servingEff[i] = eff; S.servingCompute[i] = serving; S.trainingCompute[i] = compute - serving;
    S.committedCloud[i] = committedCloud; S.flexCompute[i] = flex;
    S.leaseDepreciation[i] = leaseDep; S.ownDepreciation[i] = ownDep; S.compute[i] = compute;

    // People
    if (i > 0) {
      const h = p.headcount;
      head *= 1 + h.floor + (h.g0 - h.floor) * Math.pow(h.decay, i - 1);
    }
    const personnelCash = i === 0 ? q3("personnel") - q3("sbc")
      : head * cashPerHead0 * Math.pow(1 + p.costPerHeadGrowthQ, i);
    let sbc;
    if (i === 0) sbc = q3("sbc");
    else if (i < ipoIdx) sbc = q3("sbc");
    else {
      const k = i - ipoIdx;
      sbc = (k === 0 ? catchup : 0) + (k < nA ? (amortPool * (nA - k)) / wSum : 0)
        + p.sbc.newGrantPctPersonnelCash * personnelCash * Math.min(1, k / p.sbc.newGrantRampQuarters);
    }
    S.headcount[i] = head; S.personnelCash[i] = personnelCash; S.sbc[i] = sbc;
    S.personnel[i] = personnelCash + sbc;

    // Other opex
    const charity = i === 0 ? q3("noncash_charity") : 0;
    S.noncashCharity[i] = charity;
    S.salesMarketing[i] = i === 0 ? q3("sales_marketing") : (p.channelFeePct + p.marketingPct) * rev;
    S.otherOpex[i] = i === 0 ? q3("other_opex") : glide(p.gaPct, i) * rev;
    S.totalOpex[i] = compute + S.personnel[i] + S.salesMarketing[i] + S.otherOpex[i];
    S.operatingIncome[i] = rev - S.totalOpex[i];
    S.adjOperatingIncome[i] = S.operatingIncome[i] + sbc + charity;

    // Below the line
    S.interestIncome[i] = i === 0 ? q3("interest_income") : (liq * p.interestYield) / 4;
    S.leaseInterest[i] = leaseInt;
    S.revolverInterest[i] = (revolver * p.revolver.rate) / 4;
    S.fvMarkNotes[i] = i === ipoIdx ? -(notesAtIpo - notes) : 0;  // Q3 mark not estimable: lands at IPO
    S.pretaxIncome[i] = S.operatingIncome[i] + S.interestIncome[i] - leaseInt - S.revolverInterest[i] + S.fvMarkNotes[i];
    const taxable = S.pretaxIncome[i] - S.fvMarkNotes[i];
    let tax = 0;
    if (i > 0) {
      if (taxable < 0) nol -= taxable;
      else { const use = Math.min(nol, taxable); nol -= use; tax = p.taxRate * (taxable - use); }
    }
    S.tax[i] = tax;
    S.netIncome[i] = S.pretaxIncome[i] - tax;

    // Working capital
    const cashOpex = S.totalOpex[i] - sbc - charity - leaseDep - ownDep;
    const arN = (p.workingCapital.arDays / 91) * rev;
    const defN = p.workingCapital.defRevPctRev * rev;
    const apN = p.workingCapital.apPctCashOpex * cashOpex;

    // Cash flow
    const wcChange = -(arN - ar) + (defN - defRev) + (apN - ap);
    const cfo = S.netIncome[i] + sbc + charity + ownDep + leaseDep - S.fvMarkNotes[i] + wcChange;
    S.noncashComp[i] = sbc + charity; S.dAndA[i] = ownDep + leaseDep; S.fvAddback[i] = -S.fvMarkNotes[i];
    S.wcChange[i] = wcChange;
    ar = arN; defRev = defN; ap = apN;
    const cfi = -capex;
    let ipoNet = 0, otherEq = 0;
    if (i === ipoIdx) ipoNet = primary * (1 - p.ipo.feePct) + gPlace;
    if (i >= amdStart && i < amdStart + p.amdEquity.quarters) otherEq += p.amdEquity.total / p.amdEquity.quarters;
    let cff = ipoNet + otherEq - leasePrin;
    liq += cfo + cfi + cff;

    // Liquidity floor: revolver first, then a funding gap (new equity at the IPO price)
    let draw = 0, gap = 0;
    if (liq < p.minLiquidity) {
      draw = Math.min(p.revolver.capacity - revolver, p.minLiquidity - liq);
      revolver += draw; liq += draw;
      if (liq < p.minLiquidity) { gap = p.minLiquidity - liq; liq += gap; }
    } else if (revolver > 0) {
      draw = -Math.min(revolver, liq - p.minLiquidity);
      revolver += draw; liq += draw;
    }
    cff += draw + gap;

    // Equity roll-forward and IPO reclassifications
    equity += S.netIncome[i] + sbc + charity + ipoNet + otherEq + gap;
    if (i === ipoIdx) {
      equity += preferred + notesAtIpo;
      preferred = 0; notes = 0;
      fdShares += (primary + gPlace) / ipoPrice;
    }
    if (otherEq || gap) fdShares += (otherEq + gap) / ipoPrice;

    S.cfo[i] = cfo; S.cfi[i] = cfi; S.cff[i] = cff;
    S.capex[i] = capex; S.leaseCommenced[i] = commenced; S.leasePrincipal[i] = leasePrin; S.leasePayments[i] = leasePay;
    S.fcf[i] = cfo + cfi; S.fcfAfterLeases[i] = cfo + cfi - leasePrin;
    S.ipoProceeds[i] = ipoNet; S.otherEquityProceeds[i] = otherEq; S.revolverDraw[i] = draw; S.fundingGap[i] = gap;
    S.liquidity[i] = liq; S.accountsReceivable[i] = ar; S.deferredRevenue[i] = defRev; S.apAccrued[i] = ap;
    S.ppeNet[i] = ppe; S.leaseAsset[i] = leaseAsset; S.leaseLiability[i] = leaseLiab; S.revolver[i] = revolver;
    S.convertibleNotes[i] = notes; S.preferred[i] = preferred; S.equity[i] = equity; S.fdShares[i] = fdShares;

    S.equityProceeds[i] = ipoNet + otherEq + gap;
    S.netCashChange[i] = cfo + cfi + cff;
    S.otherAssets[i] = constAssets; S.otherLiabilities[i] = constLiabs;
    const assets = liq + ar + ppe + leaseAsset + constAssets;
    const liabEq = ap + defRev + leaseLiab + revolver + notes + constLiabs + preferred + equity;
    S.totalAssets[i] = assets; S.totalLiabEq[i] = liabEq; S.bsCheck[i] = assets - liabEq;

    S.grossMargin[i] = 1 - serving / rev;
    S.adjOpMargin[i] = S.adjOperatingIncome[i] / rev;
    S.opMargin[i] = S.operatingIncome[i] / rev;
    S.computePctRev[i] = compute / rev;

    // Resale trigger uses margins already realized, so it switches on the quarter after the run of losses.
    if (cr.enabled && resaleStart < 0 && i > 0) {
      lowRun = S.adjOpMargin[i] < (cr.triggerAdjMargin ?? 0) ? lowRun + 1 : 0;
      if (lowRun >= (cr.triggerQuarters || 2)) resaleStart = i + 1;
    }
  }

  return {
    scenario: scenarioName, label: p.label, provisional: !!p.provisional, params: p,
    periods: Array.from({ length: N }, (_, i) => qLabel(i)),
    ipo: { price: ipoPrice, quarter: p.ipo.quarter, notesValueAtIpo: notesAtIpo, primary, googlePlacement: gPlace },
    priceWar: { intensity: pwIntensity * 100, baseServingMarginEnd: baseMarginEnd, targetServingMarginEnd: pwTargetMargin, priceCutPerQ: priceCut },
    capacityResale: { enabled: !!cr.enabled, startsAt: resaleStart >= 0 && resaleStart < N ? qLabel(resaleStart) : null },
    series: S,
  };
}

// Statement layout shared by the site and the workbook. sign: -1 shows the series negated (expenses as negatives
// in the cash flow / below-the-line sections). kind: "total" rows are bold; "memo" rows are informational.
export const LAYOUT = {
  income: [
    { k: "revenue", label: "Revenue", kind: "total" },
    { k: "compute", label: "Compute & infrastructure" },
    { k: "servingCompute", label: "  of which serving (≈ cost of revenue)", kind: "memo" },
    { k: "trainingCompute", label: "  of which training / R&D", kind: "memo" },
    { k: "capacityResale", label: "  memo: idle capacity resold (netted in compute)", kind: "memo" },
    { k: "personnel", label: "Personnel" },
    { k: "salesMarketing", label: "Sales, marketing & partnerships" },
    { k: "otherOpex", label: "Other operating & administrative" },
    { k: "totalOpex", label: "Total operating expenses", kind: "total" },
    { k: "operatingIncome", label: "Operating income (loss)", kind: "total" },
    { k: "interestIncome", label: "Interest income" },
    { k: "leaseInterest", label: "Finance lease interest", sign: -1 },
    { k: "revolverInterest", label: "Revolver interest", sign: -1 },
    { k: "fvMarkNotes", label: "Change in fair value of convertible notes" },
    { k: "otherIncome", label: "Other income (expense), net" },
    { k: "pretaxIncome", label: "Pre-tax income (loss)", kind: "total" },
    { k: "tax", label: "Provision for income taxes", sign: -1 },
    { k: "netIncome", label: "Net income (loss)", kind: "total" },
    { k: "sbc", label: "Memo: stock-based compensation", kind: "memo" },
    { k: "noncashCharity", label: "Memo: non-cash donation matching", kind: "memo" },
    { k: "adjOperatingIncome", label: "Memo: adjusted operating income", kind: "memo" },
    { k: "lostRevenue", label: "Memo: revenue lost to capacity limits", kind: "memo" },
  ],
  balance: [
    { k: "liquidity", label: "Cash & short-term investments" },
    { k: "accountsReceivable", label: "Accounts receivable" },
    { k: "ppeNet", label: "Property & equipment, net" },
    { k: "leaseAsset", label: "Finance lease assets (Broadcom TPUs)" },
    { k: "otherAssets", label: "Other assets (held flat)" },
    { k: "totalAssets", label: "Total assets", kind: "total" },
    { k: "apAccrued", label: "Accounts payable & accrued" },
    { k: "deferredRevenue", label: "Deferred revenue" },
    { k: "leaseLiability", label: "Finance lease liabilities" },
    { k: "revolver", label: "Revolver borrowings" },
    { k: "convertibleNotes", label: "Convertible notes (fair value)" },
    { k: "otherLiabilities", label: "Other liabilities (held flat)" },
    { k: "preferred", label: "Redeemable convertible preferred" },
    { k: "equity", label: "Stockholders' equity (deficit)" },
    { k: "totalLiabEq", label: "Total liabilities, preferred & equity", kind: "total" },
  ],
  cashflow: [
    { k: "netIncome", label: "Net income (loss)" },
    { k: "noncashComp", label: "Stock comp & non-cash donations" },
    { k: "dAndA", label: "Depreciation (incl. finance lease assets)" },
    { k: "fvAddback", label: "Non-cash fair-value marks" },
    { k: "wcChange", label: "Working capital & other" },
    { k: "cfo", label: "Cash from operations", kind: "total" },
    { k: "capex", label: "Capital expenditures", sign: -1 },
    { k: "otherInvesting", label: "Other investing" },
    { k: "cfi", label: "Cash from investing", kind: "total" },
    { k: "equityProceeds", label: "Equity & convertible notes raised" },
    { k: "leasePrincipal", label: "Finance lease principal repaid", sign: -1 },
    { k: "revolverDraw", label: "Revolver draw (repayment)" },
    { k: "cff", label: "Cash from financing", kind: "total" },
    { k: "netCashChange", label: "Net change in cash & ST investments", kind: "total" },
    { k: "fcf", label: "Free cash flow (CFO − capex)", kind: "memo" },
    { k: "fcfAfterLeases", label: "FCF after finance lease principal", kind: "memo" },
    { k: "fundingGap", label: "Memo: funding gap (new equity required)", kind: "memo" },
  ],
};

const STOCKS = new Set(LAYOUT.balance.map((r) => r.k).concat(["headcount", "fdShares", "priceIndex"]));

// Annual roll-up: flows summed, stocks at year end. FY26 adds S-1 Q1+Q2'26 (income statement) and
// S-1 H1'26 (cash flow, restated to a cash + short-term-investments basis so it matches the model).
export function annualize(result, hist) {
  const S = result.series, years = {};
  const keys = Object.keys(S);
  result.periods.forEach((_, i) => {
    const y = qYear(i);
    years[y] ??= Object.fromEntries(keys.map((k) => [k, 0]));
    for (const k of keys) years[y][k] = STOCKS.has(k) ? S[k][i] : years[y][k] + S[k][i];
  });
  const L = hist.quarterly_is.lines, cf = hist.cash_flow, h = cf.periods.indexOf("H1'26");
  const fy = years[2026], fn = hist.functional_opex, fh = fn.periods.indexOf("H1'26");
  const isMap = { revenue: "revenue", compute: "compute", personnel: "personnel", sbc: "sbc", salesMarketing: "sales_marketing",
    otherOpex: "other_opex", totalOpex: "total_opex", operatingIncome: "operating_income", adjOperatingIncome: "adj_operating_income",
    interestIncome: "interest_income", fvMarkNotes: "fv_change_notes", otherIncome: "other_income", pretaxIncome: "pretax_income",
    tax: "tax", netIncome: "net_income", noncashCharity: "noncash_charity" };
  for (const [k, hk] of Object.entries(isMap)) fy[k] += L[hk].values[4] + L[hk].values[5];
  fy.servingCompute += fn.cost_of_revenue[fh];
  fy.trainingCompute += L.compute.values[4] + L.compute.values[5] - fn.cost_of_revenue[fh];
  const wcH1 = cf.chg_ar[h] + cf.chg_prepaid_other[h] + cf.chg_ap_accrued[h] + cf.chg_leases[h] + cf.chg_deferred_rev[h] + cf.other_noncash[h];
  const otherInvH1 = cf.other_investing[h];  // ST-investment purchases/sales excluded: they stay inside liquidity
  const eqH1 = cf.pref_stock_proceeds[h] + cf.common_stock_proceeds[h] + cf.offering_costs[h] + cf.repurchases[h];
  Object.assign(fy, {
    noncashComp: fy.noncashComp + cf.sbc[h] + cf.donation_matching[h],
    dAndA: fy.dAndA + cf.d_and_a[h],
    fvAddback: fy.fvAddback + cf.fv_change_notes[h] + cf.other_fin_instruments[h],
    wcChange: fy.wcChange + wcH1,
    cfo: fy.cfo + cf.cfo[h],
    capex: fy.capex - cf.capex[h],
    otherInvesting: fy.otherInvesting + otherInvH1,
    cfi: fy.cfi + cf.capex[h] + otherInvH1,
    equityProceeds: fy.equityProceeds + eqH1,
    leasePrincipal: fy.leasePrincipal - cf.finance_lease_principal[h],
    cff: fy.cff + cf.cff[h],
    fcf: fy.fcf + cf.cfo[h] + cf.capex[h],
    fcfAfterLeases: fy.fcfAfterLeases + cf.cfo[h] + cf.capex[h] + cf.finance_lease_principal[h],
  });
  fy.netCashChange = fy.cfo + fy.cfi + fy.cff;
  for (const y of Object.values(years)) {
    y.grossMargin = 1 - y.servingCompute / y.revenue;
    y.adjOpMargin = y.adjOperatingIncome / y.revenue;
    y.opMargin = y.operatingIncome / y.revenue;
    y.computePctRev = y.compute / y.revenue;
  }
  return years;
}
