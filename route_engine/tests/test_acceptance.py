# ==============================================================================
# test_acceptance.py  —  Acceptance Checks (spec §11), satu test per checkbox
# ==============================================================================
from __future__ import annotations

import dataclasses
import math
from collections import Counter, defaultdict
from pathlib import Path

import pytest

from route_engine.core import partition as partition_mod
from route_engine.engine import RouteEngine
from route_engine.models import Cycle, Philosophy, VisitFrequency
from route_engine.tests.conftest import make_disk_stores


# --------------------------------------------------------------------------- #
# Helper
# --------------------------------------------------------------------------- #
def _serialize(assignments):
    """Serialisasi deterministik untuk perbandingan byte-per-byte."""
    rows = [dataclasses.asdict(a) for a in assignments]
    rows.sort(key=lambda r: (r["sales_person_name"], r["day_index"], r["visit_order"], r["customer_code"]))
    return rows


def _run_blocks(assignments):
    """Group assignment per (sales, day_index)."""
    blocks = defaultdict(list)
    for a in assignments:
        blocks[(a.sales_person_name, a.day_index)].append(a)
    return blocks


# --------------------------------------------------------------------------- #
# [ ] Determinisme: dua run input identik → output identik byte-per-byte
# --------------------------------------------------------------------------- #
def test_determinism_blocking(stores_300, config_blocking):
    eng = RouteEngine()
    p1 = eng.run(stores_300, config_blocking, plan_id="P1")
    p2 = eng.run(stores_300, config_blocking, plan_id="P1")
    assert _serialize(p1.assignments) == _serialize(p2.assignments)
    assert p1.version_id == p2.version_id


def test_determinism_traffic(stores_300, config_traffic):
    eng = RouteEngine()
    p1 = eng.run(stores_300, config_traffic, plan_id="P1")
    p2 = eng.run(stores_300, config_traffic, plan_id="P1")
    assert _serialize(p1.assignments) == _serialize(p2.assignments)


def test_determinism_shuffled_input(stores_300, config_blocking):
    """Urutan baris input berbeda → output tetap identik (determinisme kuat)."""
    eng = RouteEngine()
    p1 = eng.run(stores_300, config_blocking, plan_id="P1")
    shuffled = list(reversed(stores_300))
    p2 = eng.run(shuffled, config_blocking, plan_id="P1")
    assert _serialize(p1.assignments) == _serialize(p2.assignments)


# --------------------------------------------------------------------------- #
# [ ] Fail-loud (bukan fail-silent): dep REQUIRED hilang → crash, BUKAN diam-diam
#     beralih ke algoritma lain. (Prinsip dibalik dari "no fail-closed".)
# --------------------------------------------------------------------------- #
def test_fail_loud_not_silent_deviation(stores_300, config_blocking, monkeypatch):
    eng = RouteEngine()
    # Sanity: jalur normal menghasilkan plan
    eng.run(stores_300, config_blocking, plan_id="P1")

    # Simulasi KMeansConstrained tak tersedia → HARUS crash; tidak boleh
    # menghasilkan partisi via algoritma alternatif diam-diam.
    monkeypatch.setattr(partition_mod, "KMeansConstrained", None, raising=False)
    with pytest.raises(Exception):
        eng.run(stores_300, config_blocking, plan_id="P1")


def test_preflight_rejects_missing_required(monkeypatch):
    """preflight.verify_dependencies() menolak start bila dep REQUIRED absen."""
    from route_engine.core import preflight

    monkeypatch.setattr(
        preflight, "REQUIRED",
        [("paket-hantu", "modul_yang_tidak_ada_xyz", "uji")],
    )
    with pytest.raises(RuntimeError, match="MENOLAK START"):
        preflight.verify_dependencies()


# --------------------------------------------------------------------------- #
# [ ] Hari = clump K-Means padat per sales (BLOCKING murni K-Means): per sales,
#     work_days hari di-split KMeansConstrained → tiap hari dalam [min,max] bound.
# --------------------------------------------------------------------------- #
def test_blocking_days_balanced(stores_300, config_blocking):
    from route_engine.core.scheduling import build_blocking
    from route_engine.core.partition import _count_bounds

    placement = build_blocking(stores_300, config_blocking)  # {code -> (sales, day0)}
    wd = config_blocking.work_days
    by_sales = defaultdict(list)
    for _code, (sales_idx, day_idx) in placement.items():
        by_sales[sales_idx].append(day_idx)

    for sales_idx, days in by_sales.items():
        assert all(0 <= d < wd for d in days)            # day_index0 valid
        counts = Counter(days)
        if len(days) >= wd:
            assert len(counts) == wd                     # semua hari terisi
            size_min, size_max = _count_bounds(len(days), wd, config_blocking.balance_tolerance)
            assert all(size_min <= c <= size_max for c in counts.values())


# --------------------------------------------------------------------------- #
# [ ] M2 spread: tiap toko ganjil ATAU genap (atau keduanya bila WEEKLY);
#     sebaran geografis ganjil vs genap mirip (BUKAN belah utara/selatan)
# --------------------------------------------------------------------------- #
def test_m2_every_store_has_a_week(stores_300, config_blocking):
    eng = RouteEngine()
    plan = eng.run(stores_300, config_blocking, plan_id="P1")
    for a in plan.assignments:
        assert a.visit_ganjil or a.visit_genap


def test_m2_weekly_store_both_weeks(config_blocking):
    stores = make_disk_stores(60)
    # tandai sebagian WEEKLY
    weekly_codes = {stores[i].customer_code for i in range(0, 60, 5)}
    stores = [
        dataclasses.replace(s, visit_frequency=VisitFrequency.WEEKLY) if s.customer_code in weekly_codes else s
        for s in stores
    ]
    eng = RouteEngine()
    plan = eng.run(stores, config_blocking, plan_id="P1")
    for a in plan.assignments:
        if a.customer_code in weekly_codes:
            assert a.visit_ganjil and a.visit_genap


def test_m2_kmeans_split(stores_300, config_blocking):
    """
    K-Means 2-cluster: tiap blok (sales, hari) terbagi menjadi 2 klaster
    geografis yang jelas (ganjil ≠ genap). Verifikasi:
      1. Tiap blok berisi setidaknya 1 toko ganjil DAN 1 toko genap.
      2. Balance wajar: tidak ada satu klaster yang > 80% dari total biweekly.
      3. Ganjil dan genap bersifat XOR (tidak ada toko di keduanya kecuali WEEKLY).
    """
    eng = RouteEngine()
    plan = eng.run(stores_300, config_blocking, plan_id="P1")
    blocks = _run_blocks(plan.assignments)
    checked = 0
    for (sales, day), rows in blocks.items():
        biwk = [r for r in rows if not (r.visit_ganjil and r.visit_genap)]
        if len(biwk) < 2:
            continue
        ganjil = [r for r in biwk if r.visit_ganjil]
        genap  = [r for r in biwk if r.visit_genap]
        # 1) Kedua klaster tidak kosong
        assert len(ganjil) >= 1 and len(genap) >= 1
        # 2) Balance: tidak ada klaster > 80% dari total
        total = len(biwk)
        assert max(len(ganjil), len(genap)) <= int(total * 0.8) + 1
        # 3) XOR: tidak ada toko yang ada di KEDUA list
        ganjil_codes = {r.customer_code for r in ganjil}
        genap_codes  = {r.customer_code for r in genap}
        assert ganjil_codes.isdisjoint(genap_codes)
        checked += 1
    assert checked > 0


# --------------------------------------------------------------------------- #
# [ ] Lock dihormati: setelah lock_territory (BLOCKING), edit hari tidak pernah
#     mengubah sales_person_name
# --------------------------------------------------------------------------- #
def test_lock_territory_freezes_sales(stores_300, config_blocking):
    eng = RouteEngine()
    plan = eng.run(stores_300, config_blocking, plan_id="P1")
    plan.lock_territory()
    before = {a.customer_code: a.sales_person_name for a in plan.assignments}

    # pilih satu toko, pindahkan ke hari lain dalam sales yang sama
    a0 = plan.assignments[0]
    other_day = (a0.day_index % config_blocking.work_days) + 1
    plan.move_store(a0.customer_code, other_day)

    after = {a.customer_code: a.sales_person_name for a in plan.assignments}
    assert before == after  # tak satu pun sales_person_name berubah


# --------------------------------------------------------------------------- #
# [ ] Edit lokal: memindah 1 toko antar-hari hanya mengubah baris hari sumber
#     & tujuan
# --------------------------------------------------------------------------- #
def test_local_edit_touches_only_two_days(stores_300, config_blocking):
    eng = RouteEngine()
    plan = eng.run(stores_300, config_blocking, plan_id="P1")
    plan.lock_territory()

    target = plan.assignments[0]
    src_day = target.day_index
    dst_day = (src_day % config_blocking.work_days) + 1
    sales = target.sales_person_name

    snap = {a.customer_code: (a.day_index, a.visit_order, a.visit_ganjil, a.visit_genap)
            for a in plan.assignments}

    plan.move_store(target.customer_code, dst_day)

    changed_days = set()
    for a in plan.assignments:
        new = (a.day_index, a.visit_order, a.visit_ganjil, a.visit_genap)
        if snap[a.customer_code] != new:
            # baris yang berubah harus milik sales yang sama, di hari sumber/tujuan
            assert a.sales_person_name == sales
            changed_days.add(snap[a.customer_code][0])
            changed_days.add(a.day_index)
    assert changed_days <= {src_day, dst_day}


# --------------------------------------------------------------------------- #
# [ ] Isolasi GADM: tidak ada referensi gadm_region di jalur logic
#     (di luar core/qc.py dan kontrak data models.py)
# --------------------------------------------------------------------------- #
def test_gadm_isolation():
    root = Path(__file__).resolve().parents[1]
    logic_files = [
        root / "core" / "partition.py",
        root / "core" / "scheduling.py",
        root / "core" / "biweekly.py",
        root / "core" / "estimator.py",
        root / "core" / "summary.py",
        root / "core" / "geo.py",
        root / "engine.py",
    ]
    for f in logic_files:
        src = f.read_text(encoding="utf-8")
        # cek AKSES field data administratif (mis. s.gadm_region), bukan kata di komentar
        assert "gadm_region" not in src, f"GADM bocor ke jalur logic: {f.name}"


# --------------------------------------------------------------------------- #
# [ ] No network: tidak ada panggilan jaringan di jalur logic
# --------------------------------------------------------------------------- #
def test_no_network_imports():
    root = Path(__file__).resolve().parents[1]
    # pola IMPOR / PEMANGGILAN nyata, bukan kata di komentar dokumentasi guardrail
    forbidden = [
        "import requests", "from requests", "import urllib", "from urllib",
        "import socket", "import http", "from http", "import aiohttp",
        "import httpx", "import googlemaps", "osrm_client", "urlopen(",
        "http://", "https://",
    ]
    for f in root.rglob("*.py"):
        if "tests" in f.parts:
            continue
        src = f.read_text(encoding="utf-8").lower()
        for tok in forbidden:
            assert tok not in src, f"Indikasi network '{tok}' di {f.name}"
