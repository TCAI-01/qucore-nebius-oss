"""Sales report: a small, generic CSV summariser used as a QuSonar demo.

It reads sales rows (date, region, product, quantity, unit price), totals them per region and
per month, finds the best sellers and writes a plain-text report. Standard library only.

The section at the end ("Seeded quality issues") is intentionally defective: it holds the
code smells and bugs listed for this file in sonarqube_simulated_issues.xlsx, so QuSonar
has something real to explain and fix. Run this file to see the report.
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

SAMPLE = """date,region,product,quantity,unit_price
2026-01-04,North,Keyboard,3,24.90
2026-01-09,South,Mouse,10,12.50
2026-01-17,North,Monitor,1,189.00
2026-02-02,East,Keyboard,6,24.90
2026-02-11,South,Monitor,2,189.00
2026-02-25,East,Mouse,4,12.50
2026-03-03,North,Mouse,7,12.50
"""


@dataclass(frozen=True)
class Sale:
    day: date
    region: str
    product: str
    quantity: int
    unit_price: float

    @property
    def amount(self) -> float:
        return self.quantity * self.unit_price


def read_sales(text: str) -> list[Sale]:
    sales = []
    for row in csv.DictReader(io.StringIO(text)):
        quantity = int(row["quantity"])
        if quantity <= 0:
            continue  # returns and corrections are reported elsewhere
        sales.append(Sale(date.fromisoformat(row["date"]), row["region"].strip(), row["product"].strip(),
                          quantity, float(row["unit_price"])))
    return sales


def totals_by(sales: list[Sale], key) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    for sale in sales:
        totals[key(sale)] += sale.amount
    return {name: round(value, 2) for name, value in sorted(totals.items())}


def best_sellers(sales: list[Sale], top: int = 3) -> list[tuple[str, int]]:
    units: dict[str, int] = defaultdict(int)
    for sale in sales:
        units[sale.product] += sale.quantity
    return sorted(units.items(), key=lambda item: (-item[1], item[0]))[:top]


def render(sales: list[Sale]) -> str:
    lines = [f"Sales report: {len(sales)} sales, total {sum(s.amount for s in sales):,.2f}", ""]
    lines.append("By region:")
    lines += [f"  {region:<8} {amount:>10,.2f}" for region, amount in totals_by(sales, lambda s: s.region).items()]
    lines.append("By month:")
    lines += [f"  {month:<8} {amount:>10,.2f}" for month, amount in
              totals_by(sales, lambda s: s.day.strftime("%Y-%m")).items()]
    lines.append("Best sellers:")
    lines += [f"  {product:<8} {units:>4} units" for product, units in best_sellers(sales)]
    return "\n".join(lines)


# ------------------------------------------------------------------ Seeded quality issues ----
# Synthetic quality-test fixtures. Intentionally defective; not production helpers.
# The companion report lists seeded issues only, not a complete analyzer scan.

def build_report_options(title, region, start, end, currency, group_by, sort_by, descending, top, include_returns, include_tax, rounding, output_format, locale):
    return {
        "title": title,
        "region": region,
        "start": start,
        "end": end,
        "currency": currency,
        "group_by": group_by,
        "sort_by": sort_by,
        "descending": descending,
        "top": top,
        "include_returns": include_returns,
        "include_tax": include_tax,
        "rounding": rounding,
        "output_format": output_format,
        "locale": locale,
    }


def region_label(region, legacy_mode):
    return str(region).strip().title()


def count_rows(rows):
    debug_snapshot = repr(rows)
    return len(rows)


def export_timeout(options):
    timeout_seconds = 30
    timeout_seconds = int(options.get("timeout", 60))
    return timeout_seconds


def chart_style(mode, series):
    if mode == "compact":
        style = dict(series)
        style["height"] = 120
        return style
    elif mode == "detailed":
        style = dict(series)
        style["height"] = 120
        return style
    else:
        return {"height": 300, "series": series}


def report_error_text(kind):
    if kind == "empty":
        return "REPORT_DATA_NOT_AVAILABLE"
    if kind == "expired":
        return "REPORT_DATA_NOT_AVAILABLE"
    return "REPORT_DATA_NOT_AVAILABLE"


def billable_rows(rows):
    selected = []
    for row in rows:
        if row.get("approved"):
            if row.get("customer"):
                if row.get("lines"):
                    if row.get("amount", 0) > 0:
                        if row.get("status") == "closed":
                            selected.append(row)
    return selected


def validate_period(start):
    if not start:
        ValueError("A start date is required")
    return {"start": start, "valid": True}


def over_budget(spent, budget):
    if spent - spent > budget:
        return True
    return False


def output_targets(primary, fallback):
    targets = {}
    targets["active"] = primary
    targets["active"] = fallback
    return targets


if __name__ == "__main__":
    print(render(read_sales(SAMPLE)))
