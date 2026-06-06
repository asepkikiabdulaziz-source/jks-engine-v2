# ==============================================================================
# core/scheduling.py  —  Iris hari: slice_by_bearing, build_blocking, build_traffic
# ==============================================================================
#
# slice_by_bearing adalah inti jaminan "hari berurutan melingkar".
# Diperoleh by construction (potong dari urutan bearing yang sudah ter-sort),
# bukan dari post-processing.
#
# BLOCKING (sales-first):
#   1. Partisi N sales dari semua toko (core/partition.py)
#   2. Per sales: iris work_days hari dari CENTROID WILAYAH SALES ITU SENDIRI
#      → tiap hari = irisan pai wilayah sales; kontigu melingkar
#
# TRAFFIC (day-first):
#   1. Iris work_days hari GLOBAL dari depo (atau centroid global)
#   2. Per hari: partisi N sales balanced
# ==============================================================================
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Sequence, Tuple

from .geo import bearing, centroid
from .partition import balanced_partition
from ..models import PlanConfig, BalanceCriterion

Coord = Tuple[float, float]


# ── Utilitas: potong N irisan equal-count ─────────────────────────────────────

def _equal_count_sizes(n: int, k: int) -> List[int]:
    """k irisan dari n item, kerataan COUNT (selisih ≤ 1). Deterministik."""
    if k <= 0:
        return []
    base, rem = divmod(max(0, n), k)
    return [base + (1 if i < rem else 0) for i in range(k)]


# ── slice_by_bearing ──────────────────────────────────────────────────────────

def slice_by_bearing(
    stores: Sequence,
    center: Coord,
    n_slices: int,
) -> Dict[str, int]:
    """
    Bagi toko jadi n_slices irisan pai EQUAL-COUNT terurut bearing (0°→360°).
    Return: {customer_code -> slice_index 0..n_slices-1}.

    Irisan berurutan melingkar by construction (tidak ada post-processing).
    Deterministik: sort by (bearing, customer_code) — tie-break stabil.
    """
    items = list(stores)
    if n_slices <= 0 or not items:
        return {s.customer_code: 0 for s in items}

    clat, clon = center
    ordered = sorted(
        items,
        key=lambda s: (bearing(clat, clon, s.latitude, s.longitude), s.customer_code),
    )
    sizes = _equal_count_sizes(len(ordered), n_slices)

    labels: Dict[str, int] = {}
    pos = 0
    for slice_idx, sz in enumerate(sizes):
        for _ in range(sz):
            labels[ordered[pos].customer_code] = slice_idx
            pos += 1
    return labels


# ── BLOCKING ──────────────────────────────────────────────────────────────────

def build_blocking(
    stores: Sequence,
    config: PlanConfig,
) -> Dict[str, Tuple[int, int]]:
    """
    Sales-first pipeline.
    Return: {customer_code -> (sales_index, day_index0)}.

    1. Partisi N sales dari semua toko (KMeans ±10%, fallback slice_by_bearing).
    2. Per sales: iris work_days hari dari CENTROID WILAYAH SALES → irisan pai.
    """
    # Stage 1: partisi sales
    sales_labels = balanced_partition(
        stores,
        config.n_sales,
        criterion=config.balance_criterion,
        random_state=config.random_state,
        tolerance=config.balance_tolerance,
    )

    by_sales: Dict[int, List] = defaultdict(list)
    for s in stores:
        by_sales[sales_labels[s.customer_code]].append(s)

    out: Dict[str, Tuple[int, int]] = {}
    for sales_idx, sales_stores in by_sales.items():
        # Stage 2: iris hari dari CENTROID WILAYAH SALES (bukan dari depo)
        center = centroid([s.coord for s in sales_stores])
        day_labels = slice_by_bearing(sales_stores, center, config.work_days)
        for s in sales_stores:
            out[s.customer_code] = (sales_idx, day_labels[s.customer_code])

    return out


# ── TRAFFIC ───────────────────────────────────────────────────────────────────

def build_traffic(
    stores: Sequence,
    config: PlanConfig,
) -> Dict[str, Tuple[int, int]]:
    """
    Day-first pipeline. "Keroyokan" — semua sales ke zone hari yang sama.
    Return: {customer_code -> (sales_index, day_index0)}.

    1. K-Means balanced partition ke work_days hari (kompak secara spasial).
       Pengganti slice_by_bearing — lebih natural, mengikuti gumpalan toko.
    2. Per hari: K-Means balanced partition ke n_sales.
    """
    # Stage 1: partisi ke work_days hari (K-Means, balanced, deterministik)
    day_labels = balanced_partition(
        stores,
        config.work_days,
        criterion=config.balance_criterion,
        random_state=config.random_state,
        tolerance=config.balance_tolerance,
    )

    by_day: Dict[int, List] = defaultdict(list)
    for s in stores:
        by_day[day_labels[s.customer_code]].append(s)

    out: Dict[str, Tuple[int, int]] = {}
    for day_idx, day_stores in by_day.items():
        # Stage 2: partisi ke n_sales per hari
        sales_labels = balanced_partition(
            day_stores,
            config.n_sales,
            criterion=config.balance_criterion,
            random_state=config.random_state,
            tolerance=config.balance_tolerance,
        )
        for s in day_stores:
            out[s.customer_code] = (sales_labels[s.customer_code], day_idx)

    return out


__all__ = ["slice_by_bearing", "build_blocking", "build_traffic"]
