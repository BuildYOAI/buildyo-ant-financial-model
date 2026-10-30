"""Build data/historicals.json from figures transcribed from the Anthropic S-1
(accession 0001628280-26-067168, filed 2026-10-26) plus the press-reported Q3'26 data.

Every value carries a source flag:
  s1      = stated in the S-1
  derived = arithmetic on S-1 figures (e.g. FY25 minus H1'25)
  press   = reported by press from the Oct 14-15 investor presentation
  est     = model estimate (assumption documented in `notes`)
All amounts in $ millions.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "historicals.json"

QUARTERS = ["Q1'25", "Q2'25", "Q3'25", "Q4'25", "Q1'26", "Q2'26"]

# S-1 MD&A, "Quarterly Consolidated Statements of Operations" (p.158) and non-GAAP tables (p.161)
IS_Q = {
    "revenue":            [376, 787, 1382, 2040, 4731, 11555],
    "compute":            [944, 1390, 2047, 2945, 3387, 5558],
    "personnel":          [218, 320, 489, 812, 1295, 1857],
    "bartz":              [0, 0, 1500, 0, 0, 0],
    "sales_marketing":    [24, 96, 202, 246, 1033, 2135],
    "other_opex":         [125, 181, 233, 873, 683, 1031],
    "total_opex":         [1311, 1987, 4471, 4876, 6398, 10581],
    "operating_income":   [-935, -1200, -3089, -2836, -1667, 974],
    "interest_income":    [51, 64, 124, 192, 349, 762],
    "fv_change_notes":    [-5701, -5241, -9165, -14201, -12791, -59597],
    "other_income":       [0, 0, -3, -5, -309, -8448],
    "pretax_income":      [-6585, -6377, -12133, -16850, -14418, -66309],
    "tax":                [7, 0, 5, 8, 21, 0],
    "net_income":         [-6592, -6377, -12138, -16858, -14439, -66309],
    "sbc":                [105, 181, 305, 574, 924, 1261],
    "noncash_charity":    [0, 0, 0, 541, 126, 0],
    "adj_operating_income": [-830, -1019, -1284, -1721, -617, 2235],
    "adj_net_income":     [-786, -955, -1168, -1539, -310, 2981],
}

# ---- Q3'26: press-reported anchors + flagged estimates ----
Q3_REV = 16800            # Bloomberg / The Information / CNBC, Oct 14-15 2026
REV_PER_COMPUTE = 1.70    # FT: $1.70 revenue per $1 of compute
ADJ_OP_MARGIN = 0.11      # IBTimes/Bloomberg: ~11% adjusted operating margin
SBC_Q3 = 1600             # est: continues Q1->Q2 trend (924 -> 1,261)
CHARITY_Q3 = 2000         # S-1 Note 17: $2.0B donation-matching charge in other opex, Q3'26
INTEREST_YIELD = 0.038    # est: annual yield on ~$131.7B cash + ST investments at 6/30/26

compute_q3 = round(Q3_REV / REV_PER_COMPUTE)
adj_op_q3 = round(Q3_REV * ADJ_OP_MARGIN)
op_q3 = adj_op_q3 - SBC_Q3 - CHARITY_Q3
total_opex_q3 = Q3_REV - op_q3
# split cash-like non-compute opex using Q2'26 mix, then add the disclosed charity charge
q2_mix = {k: IS_Q[k][5] for k in ("personnel", "sales_marketing", "other_opex")}
non_compute = total_opex_q3 - compute_q3 - CHARITY_Q3
mix_total = sum(q2_mix.values())
split = {k: round(non_compute * v / mix_total) for k, v in q2_mix.items()}
split["other_opex"] += non_compute - sum(split.values())  # absorb rounding
split["other_opex"] += CHARITY_Q3
interest_q3 = round((112389 + 19262) * INTEREST_YIELD / 4)
pretax_q3 = op_q3 + interest_q3  # FV marks not estimable -> excluded, flagged

Q3 = {
    "revenue": (Q3_REV, "press"),
    "compute": (compute_q3, "press"),
    "personnel": (split["personnel"], "est"),
    "bartz": (0, "est"),
    "sales_marketing": (split["sales_marketing"], "est"),
    "other_opex": (split["other_opex"], "est"),
    "total_opex": (total_opex_q3, "est"),
    "operating_income": (op_q3, "est"),
    "interest_income": (interest_q3, "est"),
    "fv_change_notes": (None, "n/e"),
    "other_income": (None, "n/e"),
    "pretax_income": (pretax_q3, "est"),
    "tax": (0, "est"),
    "net_income": (pretax_q3, "est"),
    "sbc": (SBC_Q3, "est"),
    "noncash_charity": (CHARITY_Q3, "s1"),
    "adj_operating_income": (adj_op_q3, "press"),
    "adj_net_income": (adj_op_q3 + interest_q3, "est"),
}

# S-1 annual / six-month statements (pp. F-6 to F-12)
ANNUAL_IS = {
    "periods": ["FY23", "FY24", "FY25", "H1'25", "H1'26"],
    "revenue": [41, 386, 4585, 1163, 16286],
    "compute": [433, 2522, 7326, 2334, 8945],
    "personnel": [95, 454, 1839, 538, 3152],
    "bartz": [0, 0, 1500, 0, 0],
    "sales_marketing": [2, 43, 568, 120, 3168],
    "other_opex": [62, 347, 1412, 306, 1714],
    "total_opex": [592, 3366, 12645, 3298, 16979],
    "operating_income": [-551, -2980, -8060, -2135, -693],
    "interest_income": [69, 106, 431, 115, 1111],
    "fv_change_notes": [-1045, -5434, -34308, -10942, -72388],
    "other_income": [-2, 0, -8, 0, -8757],
    "pretax_income": [-1529, -8308, -41945, -12962, -80727],
    "tax": [2, 1, 20, 7, 21],
    "net_income": [-1531, -8309, -41965, -12969, -80748],
}

# S-1 Note 8 "Supplemental Operating Expense Information" (functional view; annual + six-month only)
FUNCTIONAL = {
    "periods": ["FY23", "FY24", "FY25", "H1'25", "H1'26"],
    "cost_of_revenue": [26, 752, 2773, 1019, 2380],
    "research_development": [422, 2275, 6338, 1850, 9741],
    "sales_marketing": [76, 163, 911, 239, 3808],
    "bartz": [0, 0, 1500, 0, 0],
    "general_admin": [68, 176, 1123, 190, 1050],
    "total_opex": [592, 3366, 12645, 3298, 16979],
}

BS = {
    "periods": ["Dec 31 '24", "Dec 31 '25", "Jun 30 '26"],
    "cash": [3141, 17388, 112389],
    "st_investments": [0, 2889, 19262],
    "accounts_receivable": [95, 909, 5833],
    "prepaid_other_current": [2076, 2560, 496],
    "total_current_assets": [5312, 23746, 137980],
    "restricted_cash": [13, 13, 2529],
    "ppe_net": [19, 146, 1187],
    "rou_assets": [35, 126, 1157],
    "goodwill": [0, 154, 576],
    "other_noncurrent_assets": [2373, 476, 3929],
    "total_assets": [7752, 24661, 147358],
    "ap_accrued": [333, 2511, 5422],
    "lease_liab_current": [13, 37, 148],
    "deferred_revenue": [28, 269, 1650],
    "total_current_liabilities": [374, 2817, 7220],
    "lease_liab_noncurrent": [39, 80, 931],
    "convertible_notes": [14116, 41677, 108566],
    "other_noncurrent_liabilities": [150, 823, 750],
    "total_liabilities": [14679, 45397, 117467],
    "redeemable_preferred": [2874, 29769, 157510],
    "apic": [239, 1644, 5336],
    "aoci": [0, 5, -53],
    "accumulated_deficit": [-10040, -52154, -132902],
    "total_stockholders_deficit": [-9801, -50505, -127619],
}

CF = {
    "periods": ["FY23", "FY24", "FY25", "H1'25", "H2'25", "H1'26"],
    "net_income": [-1531, -8309, -41965, -12969, None, -80748],
    "sbc": [29, 192, 1158, 279, None, 2185],
    "d_and_a": [3, 21, 40, 14, None, 97],
    "fv_change_notes": [1045, 5434, 34308, 10942, None, 72388],
    "donation_matching": [0, 0, 541, 0, None, 126],
    "other_fin_instruments": [0, 0, 0, 0, None, 8720],
    "other_noncash": [0, 7, 11, 5, None, -7],
    "chg_ar": [-10, -90, -834, -384, None, -4982],
    "chg_prepaid_other": [-1253, -3190, 1771, 212, None, 2094],
    "chg_ap_accrued": [84, 222, 2079, 257, None, 2679],
    "chg_leases": [-1, 0, 13, 7, None, -3],
    "chg_deferred_rev": [7, 21, 241, 124, None, 1380],
    "cfo": [-1627, -5692, -2637, -1513, None, 3929],
    "capex": [-2, -15, -131, -18, None, -482],
    "purchase_st_inv": [0, 0, -3082, 0, None, -18972],
    "sale_st_inv": [0, 0, 213, 0, None, 2610],
    "other_investing": [0, -7, -77, -31, None, -337],
    "cfi": [-2, -22, -3077, -49, None, -17181],
    "pref_stock_proceeds": [445, 1188, 16548, 3549, None, 110432],
    "finance_lease_principal": [0, 0, 0, 0, None, -4],
    "convertible_notes_issued": [1750, 6050, 3450, 1300, None, 0],
    "common_stock_proceeds": [3, 10, 111, 49, None, 355],
    "repurchases": [0, 0, -149, -149, None, 0],
    "safes_issued": [122, 0, 0, 0, None, 0],
    "offering_costs": [0, 0, 0, 0, None, -9],
    "cff": [2320, 7248, 19960, 4749, None, 110774],
}
# H2'25 = FY25 - H1'25 (derived)
for k, v in CF.items():
    if k != "periods":
        v[4] = v[2] - v[3]


def check(label, a, b, tol=2):
    assert abs(a - b) <= tol, f"{label}: {a} != {b}"


def main():
    for i, q in enumerate(QUARTERS):
        r = {k: v[i] for k, v in IS_Q.items()}
        check(f"{q} opex", r["compute"] + r["personnel"] + r["bartz"] + r["sales_marketing"] + r["other_opex"], r["total_opex"])
        check(f"{q} op inc", r["revenue"] - r["total_opex"], r["operating_income"])
        check(f"{q} NI", r["pretax_income"] - r["tax"], r["net_income"])
    for i in (0, 1):
        check("H1'26 rev", IS_Q["revenue"][4] + IS_Q["revenue"][5], ANNUAL_IS["revenue"][4])
    check("FY25 rev", sum(IS_Q["revenue"][:4]), ANNUAL_IS["revenue"][2])
    for i, p in enumerate(BS["periods"]):
        check(f"{p} BS", BS["total_liabilities"][i] + BS["redeemable_preferred"][i] + BS["total_stockholders_deficit"][i], BS["total_assets"][i])
    check("Q3 vs S-1 86x ratio", Q3_REV, 86 * 197, tol=200)
    for i, p in enumerate(FUNCTIONAL["periods"]):
        f = FUNCTIONAL
        check(f"{p} functional", f["cost_of_revenue"][i] + f["research_development"][i] + f["sales_marketing"][i]
              + f["bartz"][i] + f["general_admin"][i], f["total_opex"][i])
        check(f"{p} functional vs IS", f["total_opex"][i], ANNUAL_IS["total_opex"][i])
    gross_margin = {p: round(1 - FUNCTIONAL["cost_of_revenue"][i] / ANNUAL_IS["revenue"][i], 3)
                    for i, p in enumerate(FUNCTIONAL["periods"])}

    out = {
        "meta": {
            "units": "USD millions",
            "s1": "https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/anthropicpbc-sx1.htm",
            "flags": {"s1": "Stated in S-1", "derived": "Arithmetic on S-1 figures",
                      "press": "Press-reported (Oct 14-15 2026 investor presentation)",
                      "est": "Model estimate", "n/e": "Not estimable; excluded"},
            "q3_assumptions": {
                "revenue": "16,800 per Bloomberg/The Information/CNBC; S-1 states Q3 = 86x Q4'24 ($197M) => ~16,942",
                "compute": f"revenue / {REV_PER_COMPUTE} (FT: $1.70 revenue per $1 compute)",
                "adj_operating_income": f"{ADJ_OP_MARGIN:.0%} adjusted operating margin (press; Q3-only vs YTD ambiguous)",
                "sbc": f"{SBC_Q3} est. (trend from Q1'26 924, Q2'26 1,261)",
                "non_compute_opex_split": "Q2'26 mix of personnel / S&M / other",
                "interest_income": f"{INTEREST_YIELD:.1%} annual yield on 6/30/26 cash + ST investments",
                "fv_change_notes": "Not estimated: depends on 9/30 fair value of Amazon notes (1.84B shares)",
            },
        },
        "quarterly_is": {
            "periods": QUARTERS + ["Q3'26"],
            "lines": {k: {"values": v + [Q3[k][0]], "flags": ["s1"] * 6 + [Q3[k][1]]} for k, v in IS_Q.items()},
        },
        "annual_is": ANNUAL_IS,
        "functional_opex": {**FUNCTIONAL, "gross_margin": gross_margin},
        "balance_sheet": BS,
        "cash_flow": {**CF, "flags": ["s1", "s1", "s1", "s1", "derived", "s1"]},
    }
    OUT.write_text(json.dumps(out, indent=2))
    print(f"wrote {OUT}")
    print("Q3'26 estimate:")
    for k in ("revenue", "compute", "personnel", "sales_marketing", "other_opex", "total_opex",
              "operating_income", "adj_operating_income", "interest_income", "net_income"):
        v, f = Q3[k]
        print(f"  {k:22s} {v:>8,}  [{f}]")
    print("H2'25 CFO (derived):", CF["cfo"][4], " capex:", CF["capex"][4])
    print("Gross margin (S-1 Note 8):", gross_margin)


if __name__ == "__main__":
    main()
