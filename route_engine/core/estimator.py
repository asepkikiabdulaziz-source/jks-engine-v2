# ==============================================================================
# core/estimator.py  —  NN-tour + estimasi beban
# ==============================================================================
#
# nn_tour: urutkan toko sebagai tur nearest-neighbor mulai dari `start`.
#   Dipakai untuk: (1) urutan kunjungan dalam blok, (2) input split_ganjil_genap.
#   O(n²) — cukup untuk ukuran blok lapangan (tipikalnya 5–30 toko/blok).
#
# load_score: estimasi beban satu kelompok toko.
#   Pintu tunggal untuk upgrade ke beban berbobot (omset/tier) di masa depan.
#   v1: count + estimasi panjang rute (haversine × road_factor).
# ==============================================================================
from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from .geo import haversine, centroid

Coord = Tuple[float, float]


def nn_tour(stores: Sequence, start: Coord) -> List:
    """
    Urutkan toko sebagai tur nearest-neighbor mulai dari `start`.

    Deterministik: pada tiap langkah pilih toko terdekat, tie-break by
    customer_code. Input di-sort dulu agar tie-break stabil terhadap urutan input.
    """
    remaining = list(stores)
    if len(remaining) <= 1:
        return list(remaining)

    remaining.sort(key=lambda s: s.customer_code)  # kanonik

    ordered: List = []
    cur_lat, cur_lon = start
    while remaining:
        best_i    = 0
        best_d    = haversine(cur_lat, cur_lon, remaining[0].latitude, remaining[0].longitude)
        best_code = remaining[0].customer_code
        for i in range(1, len(remaining)):
            s = remaining[i]
            d = haversine(cur_lat, cur_lon, s.latitude, s.longitude)
            if d < best_d or (d == best_d and s.customer_code < best_code):
                best_i, best_d, best_code = i, d, s.customer_code
        nxt = remaining.pop(best_i)
        ordered.append(nxt)
        cur_lat, cur_lon = nxt.latitude, nxt.longitude

    return ordered


def nn_tour_length(stores: Sequence, start: Coord, road_factor: float = 1.3) -> float:
    """Estimasi panjang tur NN (km) × road_factor. Untuk membandingkan, bukan akurat."""
    ordered = nn_tour(stores, start)
    if not ordered:
        return 0.0
    total = 0.0
    cur_lat, cur_lon = start
    for s in ordered:
        total += haversine(cur_lat, cur_lon, s.latitude, s.longitude)
        cur_lat, cur_lon = s.latitude, s.longitude
    return total * float(road_factor)


def load_score(
    store_subset: Sequence,
    start: Optional[Coord] = None,
    road_factor: float = 1.3,
) -> dict:
    """
    Estimasi beban satu kelompok toko: {count, est_route_length}.

    PINTU TUNGGAL untuk tambah bobot omset/tier nanti — ubah fungsi ini saja,
    tidak menyentuh logic lain.

    Jika `start` None, pakai centroid subset (konsisten antar-pemanggilan).
    """
    subset = list(store_subset)
    if not subset:
        return {"count": 0, "est_route_length": 0.0}
    if start is None:
        start = centroid([s.coord for s in subset])
    return {
        "count": len(subset),
        "est_route_length": nn_tour_length(subset, start, road_factor=road_factor),
    }


__all__ = ["nn_tour", "nn_tour_length", "load_score"]
