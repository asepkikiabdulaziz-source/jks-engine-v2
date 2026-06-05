# ==============================================================================
# core/summary.py  —  Ringkasan plan untuk UI "as-is → to-be"
# ==============================================================================
#
# UI menampilkan DUA angka berdampingan (count DAN est_route_length) supaya
# manajer melihat ketimpangan jarak walau pemotongan v1 pakai count.
#
# Semua beban dihitung lewat estimator.load_score (pintu tunggal upgrade tier).
# ==============================================================================
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional, Sequence, Tuple

from .estimator import load_score


def _spread_pct(values: List[float]) -> float:
    """(max - min) / avg × 100. Ukuran ketimpangan antar-unit. 0 jika <2 unit."""
    if len(values) < 2:
        return 0.0
    avg = sum(values) / len(values)
    if avg == 0:
        return 0.0
    return (max(values) - min(values)) / avg * 100.0


def build_summary(
    assignments: Sequence,
    store_index: Dict[str, object],
    start: Optional[Tuple[float, float]] = None,
    road_factor: float = 1.3,
    qc_flags: Optional[Sequence] = None,
) -> dict:
    """
    Bangun summary plan.

    start: titik mulai estimasi rute (depo) — konsisten antar-sales.
    """
    by_sales: Dict[str, List]             = defaultdict(list)
    by_day:   Dict[Tuple[str, int], List] = defaultdict(list)

    for a in assignments:
        store = store_index[a.customer_code]
        by_sales[a.sales_person_name].append(store)
        by_day[(a.sales_person_name, a.day_index)].append(store)

    per_sales = [
        {
            "sales": sales,
            **{k: (round(v, 4) if isinstance(v, float) else v)
               for k, v in load_score(stores, start=start, road_factor=road_factor).items()},
        }
        for sales, stores in sorted(by_sales.items())
    ]

    per_day = [
        {
            "sales": sales,
            "day":   day,
            **{k: (round(v, 4) if isinstance(v, float) else v)
               for k, v in load_score(stores, start=start, road_factor=road_factor).items()},
        }
        for (sales, day), stores in sorted(by_day.items())
    ]

    counts  = [p["count"] for p in per_sales]
    lengths = [p["est_route_length"] for p in per_sales]

    return {
        "per_sales": per_sales,
        "per_day":   per_day,
        "qc_flags":  [
            {"customer_code": f.customer_code, "reason": f.reason}
            for f in (qc_flags or [])
        ],
        "imbalance": {
            "count_spread_pct":      round(_spread_pct(counts), 2),
            "est_length_spread_pct": round(_spread_pct(lengths), 2),
        },
    }


__all__ = ["build_summary"]
