"""
tests/test_visit_frequency.py — Mengunci bug frekuensi kunjungan (migrasi 0009).

Bug aslinya: kolom DB berisi '1' (= MINGGUAN dalam pengkodean Nabati), sementara
_store_visit_freq hanya mencocokkan "WEEKLY" lalu MENGEMBALIKAN BIWEEKLY untuk apa
pun yang lain. Akibatnya seluruh 22.674 toko diperlakukan dua-mingguan dan 20.537
assignment dijadwalkan separuh frekuensi -- termasuk 2 plan APPROVED.

Tak ada test yang gagal waktu itu, karena tak ada yang untuk digagalkan: kodenya
"berhasil" mengembalikan nilai yang salah. Default senyap tidak punya mode
kegagalan; ia hanya punya hasil yang salah.

Test ini murni unit -- tanpa DB, tanpa jaringan.
"""
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).parent.parent))

from api import _store_visit_freq                              # noqa: E402
from route_engine.core.biweekly import split_ganjil_genap      # noqa: E402
from route_engine.models import Store, VisitFrequency          # noqa: E402


# ---------------------------------------------------------------------------
# Pemetaan kanonik
# ---------------------------------------------------------------------------

def test_weekly_dikenali():
    assert _store_visit_freq("WEEKLY") is VisitFrequency.WEEKLY


def test_biweekly_dikenali():
    assert _store_visit_freq("BIWEEKLY") is VisitFrequency.BIWEEKLY


@pytest.mark.parametrize("raw", ["weekly", " WEEKLY ", "Weekly"])
def test_toleran_spasi_dan_kapitalisasi(raw):
    assert _store_visit_freq(raw) is VisitFrequency.WEEKLY


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_kosong_jadi_biweekly(raw):
    """Kolom NOT NULL sejak 0009; ini berarti pemanggil melewatkan field-nya."""
    assert _store_visit_freq(raw) is VisitFrequency.BIWEEKLY


# ---------------------------------------------------------------------------
# INTI: nilai tak dikenal harus GAGAL, bukan diam-diam jadi BIWEEKLY
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw", ["1", "2", "4", "MONTHLY", "4/4", "mingguan", "xyz"])
def test_nilai_tak_dikenal_gagal_keras(raw):
    """Regresi yang dicegah -- persis bug produksinya.

    '1' ada di daftar ini DENGAN SENGAJA. Ia berarti MINGGUAN di pengkodean
    Nabati, tapi 1/4 dalam notasi call cycle berarti BULANAN -- angka yang sama,
    arti berlawanan. Memetakannya secara global berarti memilih satu tenant dan
    diam-diam salah untuk tenant berikutnya. Data '1' yang ada dinormalkan sekali
    oleh migrasi 0009; masukan baru harus kanonik.

    'MONTHLY' dan '4/4' juga ditolak di sini: keduanya bermakna, tapi TIDAK bisa
    direpresentasikan enum engine. Menolak di gerbang > gagal saat plan dibuat.
    """
    with pytest.raises(HTTPException) as exc:
        _store_visit_freq(raw)
    assert repr(raw) in exc.value.detail
    assert "0009" in exc.value.detail, "pesan harus menunjuk ke jalan keluarnya"


def test_pesan_galat_menyebut_nilai_kanonik():
    with pytest.raises(HTTPException) as exc:
        _store_visit_freq("1")
    assert "WEEKLY" in exc.value.detail and "BIWEEKLY" in exc.value.detail


# ---------------------------------------------------------------------------
# Akibat hilirnya -- inilah yang sesungguhnya rusak di produksi
# ---------------------------------------------------------------------------

def _toko(code, lat, lon, freq):
    return Store(customer_code=code, latitude=lat, longitude=lon, visit_frequency=freq)


def test_weekly_dikunjungi_tiap_pekan():
    """WEEKLY -> (ganjil=True, genap=True). Engine SELALU benar soal ini --
    ia hanya tak pernah menerima WEEKLY karena pemetaannya rusak di hulu."""
    stores = [_toko(f"C{i}", -6.2 + i * 0.01, 106.8 + i * 0.01, VisitFrequency.WEEKLY)
              for i in range(6)]
    out = split_ganjil_genap(stores)
    assert all(v == (True, True) for v in out.values())


def test_biweekly_dibelah_selang_pekan():
    stores = [_toko(f"C{i}", -6.2 + i * 0.01, 106.8 + i * 0.01, VisitFrequency.BIWEEKLY)
              for i in range(6)]
    out = split_ganjil_genap(stores)
    assert all(g != n for g, n in out.values()), "BIWEEKLY: tepat satu pekan aktif"


def test_salah_baca_frekuensi_memotong_kunjungan_separuh():
    """Mengukur kerusakan sesungguhnya dari bug ini, bukan sekadar pemetaannya.

    Toko yang SAMA, dibaca WEEKLY vs BIWEEKLY: jumlah kunjungan per 2 pekan
    turun separuh. Itu 20.537 assignment di produksi.
    """
    coords = [(-6.2 + i * 0.01, 106.8 + i * 0.01) for i in range(10)]
    benar  = split_ganjil_genap([_toko(f"C{i}", *c, VisitFrequency.WEEKLY)
                                 for i, c in enumerate(coords)])
    salah  = split_ganjil_genap([_toko(f"C{i}", *c, VisitFrequency.BIWEEKLY)
                                 for i, c in enumerate(coords)])

    kunjungan = lambda d: sum(int(g) + int(n) for g, n in d.values())
    assert kunjungan(benar) == 20          # 10 toko x 2 pekan
    assert kunjungan(salah) == 10          # 10 toko x 1 pekan
    assert kunjungan(salah) * 2 == kunjungan(benar)
