# ==============================================================================
# test_acceptance.py  —  Acceptance Checks (spec §11), satu test per checkbox
# ==============================================================================
from __future__ import annotations

import dataclasses
import math
from collections import Counter, defaultdict
from pathlib import Path

import pytest

from route_engine.core.geo import haversine, bearing, centroid
from route_engine.core.scheduling import slice_by_bearing
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


def _bearing_order(stores, center):
    return sorted(stores, key=lambda s: (bearing(center[0], center[1], s.latitude, s.longitude), s.customer_code))


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
# [ ] No fail-closed: blokir k-means-constrained → tetap jalan via fallback
# --------------------------------------------------------------------------- #
def test_no_fail_closed(stores_300, config_blocking, monkeypatch):
    eng = RouteEngine()
    baseline = eng.run(stores_300, config_blocking, plan_id="P1")

    # Simulasi library absen
    monkeypatch.setattr(partition_mod, "KMeansConstrained", None, raising=False)
    fallback = eng.run(stores_300, config_blocking, plan_id="P1")

    # Tidak crash, semua toko tetap ter-assign
    assert len(fallback.assignments) == len(stores_300)
    codes = {a.customer_code for a in fallback.assignments}
    assert codes == {s.customer_code for s in stores_300}

    # Fallback juga deterministik
    fallback2 = eng.run(stores_300, config_blocking, plan_id="P1")
    assert _serialize(fallback.assignments) == _serialize(fallback2.assignments)


# --------------------------------------------------------------------------- #
# [ ] Hari berurutan melingkar: batas sudut antar-hari monoton; hari terakhir
#     bertetangga hari pertama (by construction dari slice_by_bearing)
# --------------------------------------------------------------------------- #
def test_slice_by_bearing_circular_contiguous(stores_300):
    center = centroid([s.coord for s in stores_300])
    n = 6
    labels = slice_by_bearing(stores_300, center, n)
    ordered = _bearing_order(stores_300, center)
    seq = [labels[s.customer_code] for s in ordered]

    # tepat n_slices run kontigu → tidak ada label muncul di dua arc terpisah
    transitions = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    assert transitions == n - 1
    assert set(seq) == set(range(n))
    # arc menutup: label pertama & terakhir bertetangga melingkar (0 dan n-1)
    assert seq[0] == 0 and seq[-1] == n - 1


def test_days_circular_in_plan(stores_300, config_blocking):
    eng = RouteEngine()
    plan = eng.run(stores_300, config_blocking, plan_id="P1")
    # untuk tiap sales (BLOCKING), hari membentuk irisan pai kontigu di sekitar centroid sales
    by_sales = defaultdict(list)
    for a in plan.assignments:
        by_sales[a.sales_person_name].append(a)
    for sales, rows in by_sales.items():
        stores = [partition_store(plan, a.customer_code) for a in rows]
        center = centroid([s.coord for s in stores])
        ordered = sorted(zip(rows, stores), key=lambda rs: bearing(center[0], center[1], rs[1].latitude, rs[1].longitude))
        seq = [r.day_index for r, _ in ordered]
        runs = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
        # jumlah run = jumlah hari distinct - 1 (tiap hari satu arc kontigu)
        assert runs == len(set(seq)) - 1


def partition_store(plan, code):
    return plan._store_index[code]


# --------------------------------------------------------------------------- #
# [ ] Kerataan jumlah: selisih cacah toko antar-hari ≤ 10% (disepakati)
# --------------------------------------------------------------------------- #
def test_day_count_evenness(stores_300):
    center = centroid([s.coord for s in stores_300])
    n = 6
    labels = slice_by_bearing(stores_300, center, n)
    counts = Counter(labels.values())
    avg = len(stores_300) / n
    spread = max(counts.values()) - min(counts.values())
    assert spread <= max(1, math.ceil(0.10 * avg))


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
