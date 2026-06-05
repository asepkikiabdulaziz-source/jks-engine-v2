# ==============================================================================
# conftest.py  —  Fixtures deterministik (TANPA randomness, TANPA network)
# ==============================================================================
from __future__ import annotations

import math
from typing import List

import pytest

from route_engine.models import Store, PlanConfig, Cycle, Philosophy, VisitFrequency


# Golden-angle (sunflower) sampling → sebaran disk merata & deterministik.
_GOLDEN_ANGLE_DEG = 137.50776405003785


def make_disk_stores(
    n: int,
    center_lat: float = -8.10,      # sekitar Lumajang, Jawa Timur
    center_lon: float = 113.20,
    spread_deg: float = 0.25,
    prefix: str = "C",
    region: str = "Lumajang",
) -> List[Store]:
    """n toko tersebar deterministik dalam disk (sunflower). Tanpa random."""
    stores: List[Store] = []
    for i in range(n):
        r = math.sqrt((i + 0.5) / n) * spread_deg
        theta = math.radians(i * _GOLDEN_ANGLE_DEG)
        lat = center_lat + r * math.cos(theta)
        lon = center_lon + r * math.sin(theta)
        stores.append(
            Store(
                customer_code=f"{prefix}{i:04d}",
                latitude=round(lat, 6),
                longitude=round(lon, 6),
                gadm_region=region,
                visit_frequency=VisitFrequency.BIWEEKLY,
            )
        )
    return stores


@pytest.fixture
def stores_120() -> List[Store]:
    return make_disk_stores(120)


@pytest.fixture
def stores_300() -> List[Store]:
    return make_disk_stores(300)


@pytest.fixture
def depo() -> tuple[float, float]:
    # depo di pinggir disk (selatan-barat) — kasus realistis "berangkat dari gudang".
    return (-8.30, 113.00)


@pytest.fixture
def config_blocking(depo) -> PlanConfig:
    return PlanConfig(
        n_sales=4,
        depo_lat=depo[0],
        depo_lon=depo[1],
        work_days=6,
        cycle=Cycle.M2,
        philosophy=Philosophy.BLOCKING,
    )


@pytest.fixture
def config_traffic(depo) -> PlanConfig:
    return PlanConfig(
        n_sales=4,
        depo_lat=depo[0],
        depo_lon=depo[1],
        work_days=6,
        cycle=Cycle.M2,
        philosophy=Philosophy.TRAFFIC,
    )
