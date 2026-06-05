# ==============================================================================
# core/partition.py  —  Partisi toko ke N sales (BLOCKING Stage 1)
# ==============================================================================
#
# Algoritma utama : KMeansConstrained (balanced K-Means, kompak secara spasial)
# Fallback        : Recursive Median Bisection (pure Python, balance sempurna)
#
# Recursive Median Bisection:
#   1. Hitung axis terpanjang (lat atau lon) dari bounding box stores
#   2. Potong di median (sort → ambil tengah) → 2 kelompok
#   3. Ulangi rekursif tiap kelompok sampai N kelompok terbentuk
#   Hasil: kelompok persegi panjang kompak, balance COUNT sempurna (selisih ≤1),
#   deterministik, tanpa library tambahan.
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

try:
    from k_means_constrained import KMeansConstrained
except Exception:
    KMeansConstrained = None  # fallback aktif jika library tidak terpasang


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


# ── Fallback: Recursive Median Bisection ──────────────────────────────────────

def _recursive_bisection(items: List, n: int) -> Dict[str, int]:
    """
    Crash guard — pure Python, tidak butuh library tambahan.

    Potong di median axis terpanjang secara rekursif sampai N kelompok.
    Balance by COUNT sempurna (selisih antar-kelompok ≤ 1).
    Deterministik: sort by customer_code sebelum bisect agar tie-break stabil.

    Label 0..n-1 diurutkan berdasarkan centroid kelompok (bearing dari centroid
    global) supaya penomoran sales konsisten dengan output KMeans.
    """
    def _bisect(subset: List, k: int) -> List[List]:
        """Rekursif: kembalikan list k sub-list."""
        if k == 1:
            return [subset]
        lat_range = max(s.coord[0] for s in subset) - min(s.coord[0] for s in subset)
        lon_range = max(s.coord[1] for s in subset) - min(s.coord[1] for s in subset)
        axis = 0 if lat_range >= lon_range else 1  # 0=lat, 1=lon
        sorted_sub = sorted(subset, key=lambda s: (s.coord[axis], s.customer_code))
        mid     = len(sorted_sub) // 2
        k_left  = k // 2
        k_right = k - k_left
        return _bisect(sorted_sub[:mid], k_left) + _bisect(sorted_sub[mid:], k_right)

    groups = _bisect(items, n)

    # Remap ke label terurut bearing dari centroid global (konsisten dengan KMeans)
    global_ct = centroid([s.coord for s in items])
    keyed = []
    for grp_idx, grp in enumerate(groups):
        ct  = centroid([s.coord for s in grp])
        ang = bearing(global_ct[0], global_ct[1], ct[0], ct[1])
        keyed.append((ang, grp_idx, grp))
    keyed.sort()

    result: Dict[str, int] = {}
    for new_label, (_, _, grp) in enumerate(keyed):
        for s in grp:
            result[s.customer_code] = new_label
    return result


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
    v1 selalu menggunakan COUNT. ROUTE_LENGTH diterima tapi diperlakukan sama.
    """
    items = sorted(stores, key=lambda s: s.customer_code)  # kanonik
    n_total = len(items)

    if n <= 1 or n_total == 0:
        return {s.customer_code: 0 for s in items}

    if n_total <= n:
        return {s.customer_code: i for i, s in enumerate(items)}

    coords = [s.coord for s in items]
    size_min, size_max = _count_bounds(n_total, n, tolerance)

    # ── KMeansConstrained (jalur utama) ───────────────────────────────────────
    if KMeansConstrained is not None:
        try:
            import numpy as np
            X = np.asarray(coords, dtype=float)
            raw = KMeansConstrained(
                n_clusters=n,
                size_min=size_min,
                size_max=size_max,
                random_state=random_state,
            ).fit_predict(X)
            raw = [int(x) for x in raw]
            if _valid(raw, n, size_min, size_max):
                new_labels = _canonical_remap(raw, coords, n)
                return {items[i].customer_code: new_labels[i] for i in range(n_total)}
        except Exception:
            pass  # library bermasalah → fallback

    # ── Fallback: Recursive Median Bisection (pure Python) ───────────────────
    return _recursive_bisection(items, n)


__all__ = ["balanced_partition", "KMeansConstrained"]
