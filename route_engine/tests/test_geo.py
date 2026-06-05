# ==============================================================================
# test_geo.py  —  Unit math murni (salvage)
# ==============================================================================
from __future__ import annotations

import math

from route_engine.core.geo import haversine, bearing, centroid


def test_haversine_zero():
    assert haversine(-8.1, 113.2, -8.1, 113.2) == 0.0


def test_haversine_known_distance():
    # ~1 derajat lintang ≈ 111.19 km
    d = haversine(0.0, 0.0, 1.0, 0.0)
    assert abs(d - 111.19) < 0.5


def test_haversine_symmetric():
    a = haversine(-8.1, 113.2, -8.3, 113.0)
    b = haversine(-8.3, 113.0, -8.1, 113.2)
    assert a == b


def test_bearing_north():
    assert abs(bearing(0.0, 0.0, 1.0, 0.0) - 0.0) < 1e-6


def test_bearing_east():
    assert abs(bearing(0.0, 0.0, 0.0, 1.0) - 90.0) < 1e-3


def test_bearing_range():
    b = bearing(-8.1, 113.2, -8.5, 112.9)
    assert 0.0 <= b < 360.0


def test_centroid_basic():
    c = centroid([(0.0, 0.0), (2.0, 0.0), (0.0, 2.0), (2.0, 2.0)])
    assert c == (1.0, 1.0)


def test_centroid_empty_no_crash():
    assert centroid([]) == (0.0, 0.0)
