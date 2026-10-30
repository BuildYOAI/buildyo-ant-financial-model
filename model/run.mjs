// Runs all scenarios, checks the balance sheet ties every quarter, prints a summary,
// and writes data/forecast.json for the spreadsheet/site steps.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runModel, annualize, LAYOUT } from "./engine.js";

// Every subtotal must equal the sum of its parts (quarterly and annual).
function footChecks(v) {
  return {
    opInc: v.revenue - v.totalOpex - v.operatingIncome,
    opex: v.compute + v.personnel + v.salesMarketing + v.otherOpex - v.totalOpex,
    pretax: v.operatingIncome + v.interestIncome - v.leaseInterest - v.revolverInterest + v.fvMarkNotes + v.otherIncome - v.pretaxIncome,
    ni: v.pretaxIncome - v.tax - v.netIncome,
    cfo: v.netIncome + v.noncashComp + v.dAndA + v.fvAddback + v.wcChange - v.cfo,
    cfi: -v.capex + v.otherInvesting - v.cfi,
    cff: v.equityProceeds - v.leasePrincipal + v.revolverDraw - v.cff,
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assumptions = JSON.parse(readFileSync(join(root, "model/assumptions.json"), "utf8"));
const hist = JSON.parse(readFileSync(join(root, "data/historicals.json"), "utf8"));

const b = (v) => (v / 1000).toFixed(1).padStart(7);       // $B
const pct = (v) => `${(v * 100).toFixed(0)}%`.padStart(6);
const out = { generated: new Date().toISOString(), layout: LAYOUT, scenarios: {} };
let failures = 0;

for (const name of Object.keys(assumptions.scenarios)) {
  const r = runModel(assumptions, hist, name);
  const years = annualize(r, hist);
  const S = r.series;
  const maxGap = Math.max(...S.bsCheck.map(Math.abs));
  if (maxGap > 1) { failures++; console.error(`!! ${name}: balance sheet off by ${maxGap.toFixed(1)}`); }
  const rows = [
    ...r.periods.map((q, i) => [q, Object.fromEntries(Object.keys(S).map((k) => [k, S[k][i]]))]),
    ...Object.entries(years).map(([y, v]) => [`FY${y}`, v]),
  ];
  for (const [label, v] of rows) {
    for (const [chk, diff] of Object.entries(footChecks(v))) {
      if (Math.abs(diff) > 1) { failures++; console.error(`!! ${name} ${label}: ${chk} off by ${diff.toFixed(1)}`); }
    }
  }

  console.log(`\n=== ${r.label}${r.provisional ? " (PROVISIONAL)" : ""} — IPO price $${r.ipo.price.toFixed(2)}, ` +
    `notes worth $${(r.ipo.notesValueAtIpo / 1000).toFixed(1)}B at IPO, BS max gap ${maxGap.toFixed(3)}`);
  console.log("Quarter   Revenue  Compute Comp/Rev  Serve   Train   Flex  AdjOpM   OpInc  NetInc     CFO  FCF-lse  Liquid");
  for (let i = 0; i < Math.min(6, r.periods.length); i++) {
    console.log(`${r.periods[i].padEnd(8)}${b(S.revenue[i])}  ${b(S.compute[i])} ${pct(S.computePctRev[i])}  ` +
      `${b(S.servingCompute[i])}${b(S.trainingCompute[i])}${b(S.flexCompute[i])} ${pct(S.adjOpMargin[i])} ` +
      `${b(S.operatingIncome[i])} ${b(S.netIncome[i])} ${b(S.cfo[i])} ${b(S.fcfAfterLeases[i])} ${b(S.liquidity[i])}`);
  }
  console.log("Year      Revenue  Compute Comp/Rev  AdjOpM   OpM   OpInc  NetInc     CFO     FCF  FCF-lse  Liquid  FundGap");
  for (const [y, v] of Object.entries(years)) {
    console.log(`FY${y}  ${b(v.revenue)}  ${b(v.compute)} ${pct(v.computePctRev)} ${pct(v.adjOpMargin)}${pct(v.opMargin)} ` +
      `${b(v.operatingIncome)} ${b(v.netIncome)} ${b(v.cfo)} ${b(v.fcf)} ${b(v.fcfAfterLeases)} ${b(v.liquidity)} ${b(v.fundingGap)}`);
  }
  out.scenarios[name] = { label: r.label, provisional: r.provisional, ipo: r.ipo, periods: r.periods, series: S, annual: years };
}

writeFileSync(join(root, "data/forecast.json"), JSON.stringify(out));
console.log(failures ? `\n${failures} scenario(s) failed the balance check` : "\nAll scenarios: balance sheet ties every quarter.");
process.exit(failures ? 1 : 0);
