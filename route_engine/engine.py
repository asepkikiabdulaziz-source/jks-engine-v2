# ==============================================================================
# engine.py  —  RouteEngine: orkestrasi + versioning + edit lokal
# ==============================================================================
#
# Pipeline BLOCKING (sales-first):
#   QC → partisi N sales → [GATE 1: lock_territory] → iris hari per sales
#   → 6×2 → [GATE 2: lock_routes] → output
#
# Pipeline TRAFFIC (day-first):
#   QC → iris hari global → partisi N sales/hari → 6×2
#   → [GATE: lock_routes] → output
#
# Prinsip:
#   - Engine merekomendasi, manajer memutuskan. Tidak ada output terkunci tanpa
#     aksi manusia.
#   - Deterministik: input sama → output identik byte-per-byte.
#   - Edit lokal wajib lokal: pindah 1 toko hanya menyentuh blok sumber & tujuan.
# ==============================================================================
from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .constants import day_name
from .core.biweekly import split_ganjil_genap
from .core.estimator import nn_tour
from .core.geo import centroid
from .core.partition import balanced_partition
from .core.qc import run_qc
from .core.scheduling import build_blocking, build_traffic
from .core.summary import build_summary
from .models import Assignment, Cycle, PlanConfig, Philosophy, Store


# ── Versioning ────────────────────────────────────────────────────────────────

def _version_id(stores: Sequence[Store], config: PlanConfig) -> str:
    """
    version_id deterministik dari konten input + config.
    Input sama → hash sama, persis.
    """
    h = hashlib.sha1()
    for s in sorted(stores, key=lambda s: s.customer_code):
        h.update(
            f"{s.customer_code}|{s.latitude:.6f}|{s.longitude:.6f}|"
            f"{s.visit_frequency.value}|{s.tier}\n".encode()
        )
    h.update((
        f"{config.n_sales}|{config.work_days}|{config.cycle.value}|"
        f"{config.philosophy.value}|{config.balance_criterion.value}|"
        f"{config.traffic_center.value}|{config.depo_lat:.6f}|{config.depo_lon:.6f}|"
        f"{config.road_factor}|{config.random_state}"
    ).encode())
    return "v1-" + h.hexdigest()[:12]


# ── Plan ──────────────────────────────────────────────────────────────────────

@dataclass
class Plan:
    """Hasil plan + state lock + kemampuan edit lokal."""
    plan_id:    str
    version_id: str
    config:     PlanConfig
    assignments: List[Assignment]
    summary:    dict

    # internal — tidak di-serialize
    _store_index: Dict[str, Store] = field(repr=False, default_factory=dict)
    _qc_map:      Dict[str, str]   = field(repr=False, default_factory=dict)

    lock_territory_flag: bool = False
    lock_routes_flag:    bool = False
    edit_count:          int  = 0

    # ── locking ───────────────────────────────────────────────────────────────

    def lock_territory(self) -> None:
        """GATE 1 (BLOCKING): bekukan kepemilikan toko per sales."""
        self.lock_territory_flag = True

    def lock_routes(self) -> None:
        """GATE 2 (BLOCKING) / GATE tunggal (TRAFFIC): bekukan rute."""
        self.lock_routes_flag = True

    # ── edit lokal ────────────────────────────────────────────────────────────

    def move_store(
        self,
        customer_code: str,
        to_day_index: int,
        pekan: Optional[str] = None,
    ) -> set:
        """
        Pindah SATU toko ke hari lain DALAM sales yang sama.

        Hanya menyentuh blok hari sumber & tujuan (edit lokal).
        Tidak mengubah sales_person_name (kepemilikan beku setelah lock_territory).
        Return set day_index yang tersentuh.
        """
        if self.lock_routes_flag:
            raise RuntimeError("lock_routes aktif: rute beku, edit tidak diizinkan.")

        target = next(
            (a for a in self.assignments if a.customer_code == customer_code),
            None,
        )
        if target is None:
            raise KeyError(f"customer_code '{customer_code}' tidak ditemukan.")

        src_day = target.day_index
        dst_day = int(to_day_index)
        if not (1 <= dst_day <= self.config.work_days):
            raise ValueError(f"to_day_index {dst_day} di luar 1..{self.config.work_days}")

        if dst_day != src_day:
            target.day_index  = dst_day
            target.day_of_week = day_name(dst_day - 1)
            self._resequence(target.sales_person_name, src_day)
            self._resequence(target.sales_person_name, dst_day)

        self.edit_count += 1
        self.version_id = f"{self.version_id}.e{self.edit_count}"
        self._rebuild_summary()
        return {src_day, dst_day}

    # ── internal ──────────────────────────────────────────────────────────────

    def _resequence(self, sales_name: str, day_index: int) -> None:
        """Hitung ulang visit_order + ganjil/genap untuk satu blok (sales, hari)."""
        rows = [
            a for a in self.assignments
            if a.sales_person_name == sales_name and a.day_index == day_index
        ]
        if not rows:
            return

        stores  = [self._store_index[a.customer_code] for a in rows]
        depo    = (self.config.depo_lat, self.config.depo_lon)
        ordered = nn_tour(stores, depo)
        order_map = {s.customer_code: i + 1 for i, s in enumerate(ordered)}

        is_m2 = self.config.cycle == Cycle.M2
        gg    = split_ganjil_genap(ordered) if is_m2 else None

        for a in rows:
            a.visit_order  = order_map[a.customer_code]
            a.day_of_week  = day_name(day_index - 1)
            if is_m2:
                a.visit_ganjil, a.visit_genap = gg[a.customer_code]
            else:
                a.visit_ganjil = a.visit_genap = True

    def _rebuild_summary(self) -> None:
        depo = (self.config.depo_lat, self.config.depo_lon)
        qc   = [
            type("F", (), {"customer_code": c, "reason": r})()
            for c, r in self._qc_map.items()
        ]
        self.summary = build_summary(
            self.assignments, self._store_index,
            start=depo, road_factor=self.config.road_factor, qc_flags=qc,
        )


# ── SalesTerritory / SalesPartition ──────────────────────────────────────────

@dataclass
class SalesTerritory:
    """
    Wilayah satu salesman — hasil Stage 1, SEBELUM penjadwalan hari.
    Digunakan untuk preview di peta sebelum manajer menyetujui.
    """
    sales_index:    int
    sales_name:     str
    store_count:    int
    centroid_lat:   float
    centroid_lon:   float
    customer_codes: List[str]


@dataclass
class SalesPartition:
    """
    Kumpulan SalesTerritory untuk satu divisi.
    Dikembalikan oleh RouteEngine.partition_sales().
    """
    div_sls:     str
    territories: List[SalesTerritory]


# ── RouteEngine ───────────────────────────────────────────────────────────────

class RouteEngine:
    """Stateless orchestrator. Semua state hidup di objek Plan."""

    def partition_sales(
        self,
        stores:  Sequence[Store],
        config:  PlanConfig,
        div_sls: str,
    ) -> SalesPartition:
        """
        Stage 1 saja — partisi N sales, TANPA penjadwalan hari, TANPA simpan ke DB.

        Hasilnya adalah draft wilayah sales (centroid + store list) yang bisa
        ditampilkan di peta untuk review manajer sebelum Stage 2.

        Alur:
          1. Dedup customer_code (deterministik: keep first by code)
          2. balanced_partition → {customer_code → sales_index}
          3. Centroid per wilayah
          4. Return SalesPartition
        """
        seen: Dict[str, Store] = {}
        for s in sorted(stores, key=lambda s: s.customer_code):
            seen.setdefault(s.customer_code, s)
        canon: List[Store] = list(seen.values())

        if not canon:
            return SalesPartition(div_sls=div_sls, territories=[])

        sales_labels = balanced_partition(
            canon,
            config.n_sales,
            criterion=config.balance_criterion,
            random_state=config.random_state,
            tolerance=config.balance_tolerance,
        )

        by_sales: Dict[int, List[Store]] = defaultdict(list)
        for s in canon:
            by_sales[sales_labels[s.customer_code]].append(s)

        territories: List[SalesTerritory] = []
        for sales_idx in sorted(by_sales):
            grp  = by_sales[sales_idx]
            ct   = centroid([s.coord for s in grp])
            name = f"{config.depo_id}-{config.base_name}-{sales_idx + 1:02d}"
            territories.append(SalesTerritory(
                sales_index    = sales_idx,
                sales_name     = name,
                store_count    = len(grp),
                centroid_lat   = ct[0],
                centroid_lon   = ct[1],
                customer_codes = [s.customer_code for s in grp],
            ))

        return SalesPartition(div_sls=div_sls, territories=territories)

    def run(
        self,
        stores: Sequence[Store],
        config: PlanConfig,
        plan_id: str,
        version_id: Optional[str] = None,
    ) -> Plan:
        # ── dedup customer_code (deterministik: keep first by code) ────────────
        seen: Dict[str, Store] = {}
        for s in sorted(stores, key=lambda s: s.customer_code):
            seen.setdefault(s.customer_code, s)
        canon: List[Store] = list(seen.values())
        store_index = {s.customer_code: s for s in canon}

        # ── Stage 0: QC ────────────────────────────────────────────────────────
        qc_flags = run_qc(canon)
        qc_map: Dict[str, str] = {}
        for f in qc_flags:
            qc_map.setdefault(f.customer_code, f.reason)

        # ── Stage 1+2: placement {customer_code → (sales_idx, day_idx0)} ───────
        if config.philosophy == Philosophy.TRAFFIC:
            placement = build_traffic(canon, config)
        else:
            placement = build_blocking(canon, config)

        # ── version_id ─────────────────────────────────────────────────────────
        if version_id is None:
            version_id = _version_id(canon, config)

        # ── Stage 3: sequencing + 6×2 → Assignment ────────────────────────────
        blocks: Dict[Tuple[int, int], List[Store]] = defaultdict(list)
        for s in canon:
            sales_idx, day_idx0 = placement[s.customer_code]
            blocks[(sales_idx, day_idx0)].append(s)

        depo  = (config.depo_lat, config.depo_lon)
        is_m2 = config.cycle == Cycle.M2
        assignments: List[Assignment] = []

        for (sales_idx, day_idx0) in sorted(blocks):
            block_stores = blocks[(sales_idx, day_idx0)]
            ordered      = nn_tour(block_stores, depo)
            gg           = split_ganjil_genap(ordered) if is_m2 else None
            sales_name   = f"{config.depo_id}-{config.base_name}-{sales_idx + 1:02d}"
            day_index    = day_idx0 + 1

            for order, s in enumerate(ordered, 1):
                ganjil, genap = gg[s.customer_code] if is_m2 else (True, True)
                assignments.append(Assignment(
                    plan_id=str(plan_id),
                    version_id=version_id,
                    customer_code=s.customer_code,
                    store_id=str(s.store_id or s.customer_code),
                    sales_person_name=sales_name,
                    philosophy=config.philosophy.value,
                    day_index=day_index,
                    day_of_week=day_name(day_idx0),
                    visit_cycle=config.cycle.value,
                    visit_ganjil=ganjil,
                    visit_genap=genap,
                    visit_order=order,
                    qc_flag=qc_map.get(s.customer_code),
                ))

        summary = build_summary(
            assignments, store_index,
            start=depo, road_factor=config.road_factor, qc_flags=qc_flags,
        )

        return Plan(
            plan_id=str(plan_id),
            version_id=version_id,
            config=config,
            assignments=assignments,
            summary=summary,
            _store_index=store_index,
            _qc_map=qc_map,
        )


__all__ = ["RouteEngine", "Plan", "SalesTerritory", "SalesPartition"]
