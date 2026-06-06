# ==============================================================================
# core/scheduling.py  —  Iris hari: build_blocking, build_traffic
# ==============================================================================
#
# Dua filosofi penempatan toko → (sales, hari). Keduanya MURNI K-Means
# (balanced_partition / KMeansConstrained) — kompak secara spasial, deterministik.
#
# BLOCKING (sales-first):
#   1. Partisi N sales dari semua toko (core/partition.py)
#   2. Per sales: partisi work_days hari dari toko sales itu → tiap hari = clump
#      K-Means padat di dalam wilayah sales.
#
# TRAFFIC (day-first):
#   1. Partisi work_days hari GLOBAL dari semua toko
#   2. Per hari: partisi N sales balanced
# ==============================================================================
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Sequence, Tuple

from .partition import balanced_partition
from ..models import PlanConfig


# ── BLOCKING ──────────────────────────────────────────────────────────────────

def build_blocking(
    stores: Sequence,
    config: PlanConfig,
) -> Dict[str, Tuple[int, int]]:
    """
    Sales-first pipeline (murni K-Means, nested).
    Return: {customer_code -> (sales_index, day_index0)}.

    1. Partisi N sales dari semua toko (KMeansConstrained ±tolerance).
    2. Per sales: partisi work_days hari dari toko sales itu (KMeansConstrained)
       → tiap hari = clump K-Means padat di dalam wilayah sales.
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
        # Stage 2: partisi hari PER SALES dengan K-Means balanced (clump padat).
        # Catatan: hari otomatis dinomori urut bearing via _canonical_remap di
        # balanced_partition (penomoran deterministik) — keanggotaan tetap K-Means.
        day_labels = balanced_partition(
            sales_stores,
            config.work_days,
            criterion=config.balance_criterion,
            random_state=config.random_state,
            tolerance=config.balance_tolerance,
        )
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


__all__ = ["build_blocking", "build_traffic"]
