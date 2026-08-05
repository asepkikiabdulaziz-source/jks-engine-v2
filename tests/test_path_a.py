"""
tests/test_path_a.py — Jaring pengaman untuk Path A (`div.territories != null`).

Path A adalah jalur yang PALING SERING dipakai di produksi — setiap plan yang lahir
dari adjustment manual lewat sini — dan sampai berkas ini ada, NOL test menutupinya.

Dua helper:
  _build_from_territories : territories -> jadwal (K-Means hari per sales)
  _build_from_override    : jadwal hasil edit manusia, diambil APA ADANYA

Test ini ditulis SEBELUM perbaikan apa pun, untuk mengunci perilaku yang ada
sekarang. Yang berubah setelahnya harus berubah karena DISENGAJA, bukan karena
kelolosan. Murni unit — tanpa DB, tanpa jaringan.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from api import (                                              # noqa: E402
    _build_from_territories, _build_from_override,
    TerritoryIn, SalesScheduleIn, ScheduleDayIn,
)
from route_engine.models import Store, VisitFrequency          # noqa: E402


DEPO = (-6.20, 106.82)


def _store_map(n: int, freq=VisitFrequency.BIWEEKLY):
    """Titik deterministik di sekitar depo — hasilnya harus stabil antar-run."""
    return {
        f"C{i:04d}": Store(
            customer_code=f"C{i:04d}",
            latitude=-6.20 + (i % 12) * 0.008,
            longitude=106.82 + (i // 12) * 0.008,
            visit_frequency=freq,
        )
        for i in range(n)
    }


def _territories(store_map, n_sales=2):
    codes = sorted(store_map)
    per = len(codes) // n_sales
    return [
        TerritoryIn(
            sales_index=i,
            sales_name=f"1000596-TX2DA-{i+1:02d}",
            customer_codes=codes[i * per:(i + 1) * per] if i < n_sales - 1 else codes[i * per:],
        )
        for i in range(n_sales)
    ]


def _call_territories(store_map, territories, **kw):
    kw.setdefault("work_days", 6)
    kw.setdefault("cycle", "M2")
    kw.setdefault("philosophy", "BLOCKING")
    return _build_from_territories(
        store_map=store_map, territories=territories,
        depo_lat=DEPO[0], depo_lon=DEPO[1],
        kd_dist="1000596", div_sls="TX2DA",
        plan_id="test-plan", version_id="v-test",
        **kw,
    )


# ---------------------------------------------------------------------------
# _build_from_territories — bentuk keluaran
# ---------------------------------------------------------------------------

def test_semua_toko_terjadwal_tepat_sekali():
    sm = _store_map(48)
    _, _, assignments, _ = _call_territories(sm, _territories(sm))
    codes = [a["customer_code"] for a in assignments]
    assert len(codes) == len(sm)
    assert sorted(codes) == sorted(sm), "tak boleh ada toko hilang atau ganda"


def test_deterministik():
    sm = _store_map(48)
    a = _call_territories(sm, _territories(sm))[2]
    b = _call_territories(sm, _territories(sm))[2]
    assert a == b, "input sama harus menghasilkan keluaran identik"


def test_hari_dalam_rentang_work_days():
    sm = _store_map(48)
    _, _, assignments, _ = _call_territories(sm, _territories(sm), work_days=6)
    assert {a["day_index"] for a in assignments} <= set(range(1, 7))


def test_visit_order_berurutan_per_blok():
    sm = _store_map(48)
    _, _, assignments, _ = _call_territories(sm, _territories(sm))
    blok = {}
    for a in assignments:
        blok.setdefault((a["sales_person_name"], a["day_index"]), []).append(a["visit_order"])
    for (sales, hari), urutan in blok.items():
        assert sorted(urutan) == list(range(1, len(urutan) + 1)), \
            f"visit_order blok ({sales}, hari {hari}) tidak berurutan dari 1"


def test_m2_membelah_ganjil_genap():
    sm = _store_map(48)
    _, _, assignments, _ = _call_territories(sm, _territories(sm), cycle="M2")
    assert all(a["visit_ganjil"] != a["visit_genap"] for a in assignments), \
        "BIWEEKLY di M2: tepat satu pekan aktif"


def test_m1_semua_tiap_pekan():
    sm = _store_map(48)
    _, _, assignments, _ = _call_territories(sm, _territories(sm), cycle="M1")
    assert all(a["visit_ganjil"] and a["visit_genap"] for a in assignments)


def test_weekly_tetap_tiap_pekan_walau_m2():
    """Frekuensi toko mengalahkan pola siklus — perbaikan 0009 mengandalkan ini."""
    sm = _store_map(24, freq=VisitFrequency.WEEKLY)
    _, _, assignments, _ = _call_territories(sm, _territories(sm), cycle="M2")
    assert all(a["visit_ganjil"] and a["visit_genap"] for a in assignments)


def test_blocking_memakai_nama_sales_dari_territory():
    sm = _store_map(48)
    terr = _territories(sm)
    _, _, assignments, _ = _call_territories(sm, terr, philosophy="BLOCKING")
    assert {a["sales_person_name"] for a in assignments} == {t.sales_name for t in terr}


def test_kode_asing_di_territory_diabaikan_bukan_crash():
    sm = _store_map(24)
    terr = _territories(sm)
    terr[0].customer_codes = terr[0].customer_codes + ["TIDAK-ADA-001"]
    _, _, assignments, _ = _call_territories(sm, terr)
    assert len(assignments) == len(sm)


# ---------------------------------------------------------------------------
# _build_from_override — keputusan manusia diambil apa adanya
# ---------------------------------------------------------------------------

def _override(sales_name, dow, codes, ganjil=None, genap=None):
    return SalesScheduleIn(sales_name=sales_name, days=[ScheduleDayIn(
        day_of_week=dow, customer_codes=codes,
        ganjil_codes=ganjil or [], genap_codes=genap or [],
    )])


def test_override_menghormati_hari_dan_urutan():
    sm = _store_map(6)
    codes = sorted(sm)
    _, _, assignments, _ = _build_from_override(
        store_map=sm, territories=_territories(sm, 1),
        schedule_override=[_override("1000596-TX2DA-01", "Rabu", codes)],
        philosophy="BLOCKING", div_sls="TX2DA", version_id="v-test",
        depo_lat=DEPO[0], depo_lon=DEPO[1],
    )
    assert all(a["day_of_week"] == "Rabu" and a["day_index"] == 3 for a in assignments)
    assert [a["customer_code"] for a in assignments] == codes, "urutan diambil apa adanya"


def test_override_pola_pekan_dari_keanggotaan():
    sm = _store_map(4)
    c = sorted(sm)
    _, _, assignments, _ = _build_from_override(
        store_map=sm, territories=_territories(sm, 1),
        schedule_override=[_override("S-01", "Senin", c, ganjil=[c[0]], genap=[c[1]])],
        philosophy="BLOCKING", div_sls="TX2DA", version_id="v-test",
        depo_lat=DEPO[0], depo_lon=DEPO[1],
    )
    by = {a["customer_code"]: a for a in assignments}
    assert (by[c[0]]["visit_ganjil"], by[c[0]]["visit_genap"]) == (True, False)
    assert (by[c[1]]["visit_ganjil"], by[c[1]]["visit_genap"]) == (False, True)
    assert (by[c[2]]["visit_ganjil"], by[c[2]]["visit_genap"]) == (True, True), "M1"
    assert by[c[2]]["visit_cycle"] == "M1"


def test_override_kode_asing_dilewati():
    sm = _store_map(4)
    _, _, assignments, _ = _build_from_override(
        store_map=sm, territories=_territories(sm, 1),
        schedule_override=[_override("S-01", "Senin", sorted(sm) + ["HANTU"])],
        philosophy="BLOCKING", div_sls="TX2DA", version_id="v-test",
        depo_lat=DEPO[0], depo_lon=DEPO[1],
    )
    assert len(assignments) == 4


# ---------------------------------------------------------------------------
# CACAT YANG SEDANG DIPERBAIKI — dinyatakan sebagai harapan, bukan diterima
# ---------------------------------------------------------------------------

def test_qc_flag_terisi_untuk_toko_menyimpang():
    """Path A kini menjalankan run_qc seperti Path B, bukan mengeset qc_flag=None.

    gross_outlier_check bekerja atas `gadm_region` (hasil reverse-geocoding),
    BUKAN jarak geografis mentah -- lihat core/qc.py:32. Toko tanpa gadm_region
    diam-diam dilewati cek ini (`if s.gadm_region` di baris 48), jadi outlier
    murni koordinat butuh stacked_coordinate_check, bukan gross_outlier_check.
    Test ini memakai gadm_region yang menyimpang, sesuai kontrak fungsinya.
    """
    sm = _store_map(24)
    for s in sm.values():
        object.__setattr__(s, "gadm_region", "Jawa Barat")
    outlier = Store(customer_code="C9999", latitude=-8.9, longitude=112.5,
                     gadm_region="Jawa Timur")
    sm["C9999"] = outlier
    terr = _territories(sm)
    _, _, assignments, _ = _call_territories(sm, terr)
    flags = {a["customer_code"]: a["qc_flag"] for a in assignments if a["qc_flag"]}
    assert "C9999" in flags, "Path A harus menjalankan QC seperti Path B"
    assert "gross_outlier" in flags["C9999"]


def test_ada_summary_untuk_path_a():
    """Path A kini menghitung summary dgn mesin yang sama seperti Path B, bukan
    menyimpan summary_map[div] = {} di generate_plan."""
    sm = _store_map(48)
    hasil = _call_territories(sm, _territories(sm))
    assert len(hasil) == 4
    summary = hasil[3]
    assert summary and "per_sales" in summary and "imbalance" in summary
