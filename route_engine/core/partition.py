# ==============================================================================
# core/partition.py  —  Partisi toko ke N sales (BLOCKING Stage 1)
# ==============================================================================
#
# Algoritma : KMeansConstrained (balanced K-Means, kompak secara spasial).
#             REQUIRED — diverifikasi saat startup via core/preflight.py.
#             TIDAK ADA fallback algoritma alternatif: bila absen → engine menolak
#             start; bila error runtime → propagate (crash). Lebih baik crash
#             terlihat daripada menyimpang senyap ke algoritma lain (Prinsip 1 & 3).
#
# Toleransi KMeans: ±tolerance dari rata-rata (default 0.10 = ±10%).
# Deterministik: stores di-sort by customer_code sebelum diolah;
#                label KMeans di-remap ke urutan bearing dari centroid global.
# ==============================================================================
from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, List, Sequence

from .geo import bearing, centroid
from ..constants import BALANCE_TOLERANCE
from ..models import BalanceCriterion

from k_means_constrained import KMeansConstrained  # REQUIRED — diverifikasi via preflight


# ── Batas ukuran cluster untuk KMeans ─────────────────────────────────────────

def _count_bounds(n_total: int, n: int, tolerance: float = BALANCE_TOLERANCE) -> tuple[int, int]:
    """
    Batas min/max ukuran cluster untuk kerataan ±tolerance.

    Contoh: 100 toko, 3 sales, tol=0.10 → avg=33.3 → min=30, max=37.
    Feasibility dijamin: size_min*n ≤ n_total ≤ size_max*n.
    """
    if n <= 0:
        return (0, n_total)
    avg = n_total / n
    size_min = max(1, int(math.floor(avg * (1 - tolerance))))
    size_max = int(math.ceil(avg * (1 + tolerance)))
    while size_min * n > n_total and size_min > 1:
        size_min -= 1
    while size_max * n < n_total:
        size_max += 1
    return size_min, size_max


# ── Remap label KMeans ke urutan deterministik ────────────────────────────────

def _canonical_remap(labels: List[int], coords: List[tuple], n: int) -> List[int]:
    """
    Remap label cluster ke 0..n-1 terurut bearing centroid tiap cluster
    dari centroid global → penomoran sales deterministik & melingkar.
    """
    global_ct = centroid(coords)
    members: Dict[int, List[int]] = defaultdict(list)
    for i, lab in enumerate(labels):
        members[lab].append(i)

    keys = []
    for lab, idxs in members.items():
        c = centroid([coords[i] for i in idxs])
        ang = bearing(global_ct[0], global_ct[1], c[0], c[1])
        keys.append((ang, lab))
    keys.sort()

    old_to_new = {lab: new for new, (_, lab) in enumerate(keys)}
    return [old_to_new[lab] for lab in labels]


# ── Validasi hasil KMeans ─────────────────────────────────────────────────────

def _valid(labels: List[int], n: int, size_min: int, size_max: int) -> bool:
    counts = [0] * n
    for lab in labels:
        counts[lab] += 1
    return all(size_min <= c <= size_max for c in counts)


# ── API publik ─────────────────────────────────────────────────────────────────

def balanced_partition(
    stores: Sequence,
    n: int,
    criterion: BalanceCriterion = BalanceCriterion.COUNT,
    random_state: int = 42,
    tolerance: float = BALANCE_TOLERANCE,
) -> Dict[str, int]:
    """
    Partisi toko ke N sales (DRAFT untuk digeser manajer di Gate 1).
    Return: {customer_code -> sales_index 0..n-1}.

    tolerance: batas kerataan ±X per cluster dari rata-rata (default 0.10 = ±10%).

    criterion: hanya COUNT yang diimplementasi. Nilai lain DITOLAK — lihat
    BalanceCriterion. `PlanConfig` sudah menolaknya lebih awal, tapi fungsi ini
    juga bisa dipanggil LANGSUNG (scheduling.py, api.py, dan siapa pun yang
    memakai route_engine sebagai paket), jadi gerbangnya dipasang di sini juga.
    """
    if criterion is not BalanceCriterion.COUNT:
        raise NotImplementedError(
            f"balanced_partition: criterion={criterion.value} belum diimplementasi. "
            "Hanya COUNT yang tersedia. Menerimanya lalu diam-diam memakai COUNT "
            "adalah penyimpangan senyap — Prinsip 1 & 3."
        )

    items = sorted(stores, key=lambda s: s.customer_code)  # kanonik
    n_total = len(items)

    if n <= 1 or n_total == 0:
        return {s.customer_code: 0 for s in items}

    if n_total <= n:
        return {s.customer_code: i for i, s in enumerate(items)}

    coords = [s.coord for s in items]
    size_min, size_max = _count_bounds(n_total, n, tolerance)

    # ── KMeansConstrained — jalur TUNGGAL (REQUIRED, tanpa fallback senyap) ────
    # Error apa pun dibiarkan propagate: lebih baik crash terlihat daripada
    # diam-diam beralih ke algoritma lain (Prinsip 1 & 3).
    import numpy as np
    X = np.asarray(coords, dtype=float)
    raw = KMeansConstrained(
        n_clusters=n,
        size_min=size_min,
        size_max=size_max,
        random_state=random_state,
    ).fit_predict(X)
    raw = [int(x) for x in raw]
    if not _valid(raw, n, size_min, size_max):
        # KMeansConstrained menjamin bounds; bila tetap dilanggar ada masalah
        # fundamental — gagalkan dengan konteks, jangan sembunyikan.
        raise RuntimeError(
            f"KMeansConstrained: partisi di luar bounds [{size_min},{size_max}] "
            f"(n={n}, total={n_total}). Crash > menyimpang senyap."
        )
    new_labels = _canonical_remap(raw, coords, n)
    return {items[i].customer_code: new_labels[i] for i in range(n_total)}


__all__ = ["balanced_partition", "KMeansConstrained"]
