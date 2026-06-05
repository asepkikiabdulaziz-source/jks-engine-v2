# ==============================================================================
# models.py  —  Kontrak data engine
# ==============================================================================
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ── Enums ──────────────────────────────────────────────────────────────────────

class VisitFrequency(str, Enum):
    BIWEEKLY = "BIWEEKLY"   # kunjungan 2 minggu sekali (default)
    WEEKLY   = "WEEKLY"     # kunjungan tiap minggu


class Cycle(str, Enum):
    M1 = "M1"   # 1 pola — ganjil = genap = True (kunjungi tiap pekan)
    M2 = "M2"   # 2 pola — ganjil/genap bergantian (6×2)


class Philosophy(str, Enum):
    BLOCKING = "BLOCKING"   # sales-first: wilayah per sales, lalu iris hari
    TRAFFIC  = "TRAFFIC"    # day-first: iris hari global, lalu partisi sales/hari


class BalanceCriterion(str, Enum):
    COUNT        = "COUNT"         # v1 — seimbangkan jumlah toko
    ROUTE_LENGTH = "ROUTE_LENGTH"  # v2 — seimbangkan estimasi panjang rute (belum impl)


class TrafficCenter(str, Enum):
    DEPO            = "DEPO"            # berangkat dari depo (default)
    GLOBAL_CENTROID = "GLOBAL_CENTROID" # untuk kasus depo di pinggir


# ── Input ──────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Store:
    """
    Satu toko. `gadm_region` hanya dipakai di QC, tidak pernah masuk
    ke logic partisi atau penjadwalan.
    """
    customer_code:   str
    latitude:        float
    longitude:       float
    visit_frequency: VisitFrequency = VisitFrequency.BIWEEKLY
    gadm_region:     Optional[str]  = None
    tier:            Optional[str]  = None   # belum ada data — jalur disiapkan
    store_id:        Optional[str]  = None   # uuid downstream; default = customer_code

    @property
    def coord(self) -> tuple[float, float]:
        return (self.latitude, self.longitude)


@dataclass(frozen=True)
class PlanConfig:
    """Konfigurasi satu run plan."""
    n_sales:           int
    depo_lat:          float
    depo_lon:          float
    work_days:         int              = 6
    cycle:             Cycle            = Cycle.M1
    philosophy:        Philosophy       = Philosophy.BLOCKING
    balance_criterion: BalanceCriterion = BalanceCriterion.COUNT
    traffic_center:    TrafficCenter    = TrafficCenter.DEPO
    road_factor:        float            = 1.3   # haversine → estimasi jarak jalan (display)
    balance_tolerance:  float            = 0.10  # toleransi kerataan per-sales (0.10 = ±10%)
    depo_id:            str              = "DEPO"
    base_name:          str              = "SALES"
    random_state:       int              = 42    # tetap — input sama → output sama


# ── Output ─────────────────────────────────────────────────────────────────────

@dataclass
class Assignment:
    """Satu baris output: satu toko untuk satu sales di satu hari."""
    plan_id:          str
    version_id:       str
    customer_code:    str
    store_id:         str
    sales_person_name: str   # format: "{depo_id}-{base_name}-{idx+1:02d}"
    philosophy:       str    # BLOCKING | TRAFFIC
    day_index:        int    # 1..work_days
    day_of_week:      str    # Senin, Selasa, ...
    visit_cycle:      str    # M1 | M2
    visit_ganjil:     bool
    visit_genap:      bool
    visit_order:      int    # urutan kunjungan dalam blok (sales, hari)
    qc_flag:          Optional[str] = None


@dataclass
class QCFlag:
    customer_code: str
    reason:        str


__all__ = [
    "VisitFrequency", "Cycle", "Philosophy", "BalanceCriterion", "TrafficCenter",
    "Store", "PlanConfig", "Assignment", "QCFlag",
]
