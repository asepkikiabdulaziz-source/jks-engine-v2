# ==============================================================================
# core/geo.py  —  Math geo murni: haversine, bearing, centroid
# ==============================================================================
from __future__ import annotations

import math
from typing import Iterable, Sequence, Tuple

EARTH_RADIUS_KM = 6371.0
Coord = Tuple[float, float]  # (latitude, longitude) derajat desimal


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Jarak great-circle antara dua titik (km)."""
    rlat1, rlon1 = math.radians(lat1), math.radians(lon1)
    rlat2, rlon2 = math.radians(lat2), math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = (math.sin(dlat / 2) ** 2
         + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2)
    a = min(1.0, max(0.0, a))  # clamp floating-point error
    return EARTH_RADIUS_KM * 2.0 * math.asin(math.sqrt(a))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Sudut arah dari titik 1 ke titik 2 (derajat, 0–360, searah jarum jam dari utara)."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(rlat2)
    x = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def centroid(points: Iterable[Coord]) -> Coord:
    """Centroid aritmetik (mean lat, mean lon). Mengembalikan (0, 0) jika kosong."""
    pts: Sequence[Coord] = list(points)
    n = len(pts)
    if n == 0:
        return (0.0, 0.0)
    return (
        math.fsum(p[0] for p in pts) / n,
        math.fsum(p[1] for p in pts) / n,
    )


__all__ = ["haversine", "bearing", "centroid", "EARTH_RADIUS_KM", "Coord"]
