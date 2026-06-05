# ==============================================================================
# core/qc.py  —  Stage 0 QC: surface masalah, jangan auto-fix
# ==============================================================================
#
# SATU-SATUNYA modul yang menyentuh gadm_region.
# gadm_region tidak pernah masuk ke logic partisi atau penjadwalan.
#
# QC tidak menghentikan pipeline. Flag dibawa terus ke output.
# ==============================================================================
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Dict, List, Optional, Sequence

from .geo import haversine
from ..constants import STACKED_RADIUS_M, STACKED_MIN_COUNT
from ..models import QCFlag


# ── gross_outlier_check ────────────────────────────────────────────────────────

def gross_outlier_check(
    stores: Sequence,
    expected_region: Optional[str] = None,
) -> List[QCFlag]:
    """
    Flag toko yang gadm_region-nya melenceng dari mayoritas.

    Contoh: koordinat Lumajang ter-resolve ke Banten → hampir pasti salah input.
    Jika expected_region None, pakai region mayoritas sebagai acuan.
    """
    regions = [s.gadm_region for s in stores if s.gadm_region]
    if not regions:
        return []

    if expected_region is None:
        counts = Counter(regions)
        top = max(counts.values())
        # tie-break deterministik by nama region
        expected_region = sorted(r for r, c in counts.items() if c == top)[0]

    return [
        QCFlag(
            customer_code=s.customer_code,
            reason=f"gross_outlier: gadm_region '{s.gadm_region}' != '{expected_region}'",
        )
        for s in stores
        if s.gadm_region and s.gadm_region != expected_region
    ]


# ── stacked_coordinate_check ──────────────────────────────────────────────────

class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def stacked_coordinate_check(
    stores: Sequence,
    radius_m: float = STACKED_RADIUS_M,
    min_count: int = STACKED_MIN_COUNT,
) -> List[QCFlag]:
    """
    Flag masalah koordinat yang tidak terdeteksi GADM tapi merusak metrik jarak:

    a. Koordinat duplikat persis — banyak toko share lat/lon identik
       (indikasi isian centroid kelurahan / entri malas).
    b. Tumpukan rapat tidak wajar — ≥ min_count toko dalam radius < radius_m meter.
    """
    items = list(stores)
    n = len(items)
    if n == 0:
        return []

    flags: List[QCFlag] = []

    # (a) duplikat persis
    by_coord: Dict[tuple, List] = defaultdict(list)
    for s in items:
        by_coord[(s.latitude, s.longitude)].append(s)
    for coord, members in by_coord.items():
        if len(members) >= 2:
            for s in members:
                flags.append(QCFlag(
                    customer_code=s.customer_code,
                    reason=(
                        f"stacked_exact: {len(members)} toko berbagi "
                        f"koordinat identik {coord}"
                    ),
                ))

    # (b) tumpukan rapat (jarak > 0 tapi ≤ radius_m)
    radius_km = radius_m / 1000.0
    uf = _UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            d = haversine(
                items[i].latitude, items[i].longitude,
                items[j].latitude, items[j].longitude,
            )
            if 0.0 < d <= radius_km:
                uf.union(i, j)

    comp: Dict[int, List[int]] = defaultdict(list)
    for i in range(n):
        comp[uf.find(i)].append(i)

    already = {f.customer_code for f in flags}
    for _, idxs in comp.items():
        if len(idxs) < min_count:
            continue
        has_near = any(
            0.0 < haversine(
                items[a].latitude, items[a].longitude,
                items[b].latitude, items[b].longitude,
            ) <= radius_km
            for a in idxs for b in idxs if a < b
        )
        if not has_near:
            continue
        for i in idxs:
            code = items[i].customer_code
            if code not in already:
                flags.append(QCFlag(
                    customer_code=code,
                    reason=f"stacked_tight: {len(idxs)} toko dalam radius {radius_m:g} m",
                ))

    return flags


# ── run_qc ────────────────────────────────────────────────────────────────────

def run_qc(
    stores: Sequence,
    expected_region: Optional[str] = None,
    radius_m: float = STACKED_RADIUS_M,
    min_count: int = STACKED_MIN_COUNT,
) -> List[QCFlag]:
    """
    Jalankan semua QC check. Tidak menghentikan pipeline.
    Output deterministik: terurut (customer_code, reason).
    """
    flags = (
        gross_outlier_check(stores, expected_region)
        + stacked_coordinate_check(stores, radius_m, min_count)
    )
    flags.sort(key=lambda f: (f.customer_code, f.reason))
    return flags


__all__ = ["gross_outlier_check", "stacked_coordinate_check", "run_qc"]
