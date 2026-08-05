# ==============================================================================
# test_contiguity.py — MST gap heuristic (core/contiguity.py)
# ==============================================================================
#
# Doktrin yang diuji: UKUR dan LAPORKAN keterhubungan geografis, JANGAN paksa
# sebagai kendala K-Means. Test ini mengunci PERILAKU PENGUKURAN, bukan
# menuntut engine menolak/memaksa apa pun atas hasilnya.
#
# Metode final: sisi MST dihitung "jeda" hanya bila LOLOS KEDUANYA —
# (a) >= min_gap_km (mutlak) DAN (b) > gap_multiplier x median sisi lain
# (relatif). Dua pendekatan lebih awal (relatif saja; lompatan-rasio-terbesar)
# diverifikasi RUSAK pada 2.293 toko nyata Nabati sebelum desain ini dipilih —
# lihat riwayat git & docstring contiguity_score untuk detailnya. Beberapa test
# di sini secara eksplisit mengunci KENAPA versi itu ditinggalkan.
# ==============================================================================
from __future__ import annotations

from route_engine.constants import CONTIGUITY_GAP_MULTIPLIER, CONTIGUITY_MIN_GAP_KM
from route_engine.core.contiguity import _mst_edge_lengths, contiguity_score
from route_engine.core.summary import build_summary
from route_engine.models import Store


def _toko(code: str, lat: float, lon: float) -> Store:
    return Store(customer_code=code, latitude=lat, longitude=lon)


def _cluster(prefix: str, center: tuple, n: int, step: float = 0.003):
    """Titik rapat di sekitar `center` — satu blob, tanpa celah (~0.3 km antar-titik)."""
    lat0, lon0 = center
    return [
        _toko(f"{prefix}{i:02d}", lat0 + (i % 3) * step, lon0 + (i // 3) * step)
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Kasus dasar
# ---------------------------------------------------------------------------

def test_kosong_dan_satu_toko():
    assert contiguity_score([]) == {"n_islands": 1, "max_gap_km": 0.0, "gap_ratio": 0.0}
    assert contiguity_score([_toko("A", -6.2, 106.8)]) == \
        {"n_islands": 1, "max_gap_km": 0.0, "gap_ratio": 0.0}


def test_dua_toko_selalu_satu_blob():
    """<3 toko: tak ada dasar pembanding yang bermakna -- dinyatakan 1 blob,
    walau jaraknya sangat jauh secara mutlak."""
    dekat = contiguity_score([_toko("A", -6.20, 106.80), _toko("B", -6.201, 106.801)])
    jauh  = contiguity_score([_toko("A", -6.20, 106.80), _toko("B", -7.50, 108.00)])
    assert dekat["n_islands"] == 1
    assert jauh["n_islands"] == 1
    assert jauh["max_gap_km"] > dekat["max_gap_km"], "jarak tetap dilaporkan jujur"
    assert jauh["gap_ratio"] == 0.0, "tanpa median pembanding, ratio tak dihitung"


def test_klaster_rapat_satu_blob():
    hasil = contiguity_score(_cluster("A", (-6.20, 106.80), 12))
    assert hasil["n_islands"] == 1
    assert hasil["max_gap_km"] < CONTIGUITY_MIN_GAP_KM, "klaster rapat tak boleh dekati ambang mutlak"


def test_dua_klaster_jauh_terdeteksi_sebagai_dua_pulau():
    """Kasus inti: satu 'wilayah' K-Means yang sebenarnya dua blob terpisah jauh
    (mis. dibelah sungai/selat) -- persis skenario yang literatur districting
    peringatkan tak dijamin K-Means murni."""
    blob_a = _cluster("A", (-6.20, 106.80), 6)   # Jakarta-ish
    blob_b = _cluster("B", (-6.90, 107.60), 6)   # Bandung-ish, ~100km
    hasil = contiguity_score(blob_a + blob_b)
    assert hasil["n_islands"] == 2
    assert hasil["max_gap_km"] > 50
    assert hasil["gap_ratio"] > CONTIGUITY_GAP_MULTIPLIER


def test_tiga_klaster_tiga_pulau():
    blob_a = _cluster("A", (-6.20, 106.80), 4)
    blob_b = _cluster("B", (-6.90, 107.60), 4)
    blob_c = _cluster("C", (-7.80, 110.40), 4)  # Yogya-ish
    hasil = contiguity_score(blob_a + blob_b + blob_c)
    assert hasil["n_islands"] == 3


def test_deterministik():
    stores = _cluster("A", (-6.20, 106.80), 10) + _cluster("B", (-6.90, 107.60), 10)
    a = contiguity_score(stores)
    b = contiguity_score(list(reversed(stores)))  # urutan input dibalik
    assert a == b, "hasil tak boleh bergantung urutan input"


# ---------------------------------------------------------------------------
# Kenapa DUA syarat (mutlak DAN relatif), bukan salah satu saja
# ---------------------------------------------------------------------------

def test_ambang_relatif_saja_akan_gagal_pada_klaster_padat_besar():
    """Mengunci kegagalan yang mendasari pemilihan desain ini.

    Klaster padat besar (kepadatan menurun halus dari pusat) menghasilkan sisi
    MST yang membentang kontinu dari puluhan meter sampai beberapa km — TAPI
    tak pernah keluar dari rentang "satu wilayah kota" (di data nyata 2.293
    toko Nabati, batas atasnya konsisten ≈ 5 km di semua ukuran teritori).
    Ambang RELATIF SAJA (tanpa syarat mutlak) menandai sisi wajar di ujung
    sebaran seperti ini sebagai "jeda" — versi pertama modul ini menghasilkan
    60+ "pulau" palsu untuk 459 toko nyata dengan pola gradien serupa.

    Grid di bawah dikalibrasi (bukan ditebak) agar max_edge ≈ 2,7 km — realistis
    untuk satu wilayah kota, TAPI cukup untuk memicu kegagalan versi relatif-saja.
    """
    # Grid 18x12, kerapatan menurun -- meniru pusat kota (rapat) ke pinggiran
    # (renggang) dalam SATU wilayah yang sepenuhnya terhubung secara geografis.
    stores = []
    for i in range(18):
        step = 0.0008 * (1 + i * 0.9)  # kerapatan mengecil seiring i membesar
        for j in range(12):
            stores.append(_toko(f"G{i}_{j}", -6.20 + i * step, 106.80 + j * step))

    hasil_gabungan = contiguity_score(stores)  # default: mutlak DAN relatif
    hasil_relatif_saja = contiguity_score(stores, min_gap_km=0.0)  # syarat mutlak dimatikan

    assert max(_mst_edge_lengths(stores)) < CONTIGUITY_MIN_GAP_KM * 2, \
        "fixture harus tetap dalam skala realistis satu wilayah kota"
    assert hasil_gabungan["n_islands"] == 1, \
        "dengan syarat mutlak, gradien kepadatan wajar tak boleh dianggap terputus"
    assert hasil_relatif_saja["n_islands"] > hasil_gabungan["n_islands"], \
        "membuktikan syarat mutlak-lah yang menyelamatkan, bukan kebetulan"


def test_ambang_mutlak_saja_akan_gagal_pada_wilayah_pedesaan_jarang():
    """Wilayah pedesaan yang memang jarang (spacing wajar > min_gap_km antar
    toko) TIDAK boleh dianggap terputus selama sisi-sisinya SEBANDING satu sama
    lain -- itulah gunanya syarat relatif di samping syarat mutlak."""
    # 8 toko berjajar, spacing SERAGAM ~8 km -- pedesaan wajar, bukan pulau.
    stores = [_toko(f"D{i}", -7.00 + i * 0.072, 110.00) for i in range(8)]
    hasil = contiguity_score(stores)
    assert hasil["n_islands"] == 1, \
        "spacing seragam (walau tiap sisi > min_gap_km) bukan tanda pembelahan"


def test_gap_multiplier_monoton():
    """Menaikkan gap_multiplier tak pernah MENAMBAH jumlah pulau yang terdeteksi
    -- invarian, bukan angka ajaib tertentu."""
    blob_a = _cluster("A", (-6.20, 106.80), 6)
    blob_b = _cluster("B", (-6.35, 106.95), 6)  # ~20km
    ketat   = contiguity_score(blob_a + blob_b, gap_multiplier=1.0)
    sedang  = contiguity_score(blob_a + blob_b, gap_multiplier=10.0)
    longgar = contiguity_score(blob_a + blob_b, gap_multiplier=1000.0)
    assert ketat["n_islands"] >= sedang["n_islands"] >= longgar["n_islands"]
    assert longgar["n_islands"] == 1, "multiplier ekstrem harus akhirnya melebur"


def test_min_gap_km_monoton():
    """Menaikkan min_gap_km tak pernah MENAMBAH jumlah pulau yang terdeteksi."""
    blob_a = _cluster("A", (-6.20, 106.80), 6)
    blob_b = _cluster("B", (-6.90, 107.60), 6)  # ~100km
    ketat   = contiguity_score(blob_a + blob_b, min_gap_km=0.5)
    longgar = contiguity_score(blob_a + blob_b, min_gap_km=500.0)
    assert ketat["n_islands"] >= longgar["n_islands"]
    assert longgar["n_islands"] == 1


# ---------------------------------------------------------------------------
# Robust terhadap koordinat duplikat/nyaris-duplikat
# ---------------------------------------------------------------------------

def test_tahan_terhadap_koordinat_nyaris_duplikat():
    """Beberapa toko di titik nyaris sama (data kotor -- lihat
    stacked_coordinate_check) tak boleh membuat sisi jauh yang SAH di tempat
    lain jadi salah dihitung, akibat median tergelincir ke nyaris-nol.

    Ini kegagalan nyata dari percobaan desain kedua (lompatan-rasio-terbesar):
    menyuntik pembelahan buatan 25 km vs 5 km ke sampel yang sama menghasilkan
    n_islands IDENTIK -- buktinya sedang bereaksi ke derau, bukan ke fitur yang
    sungguh disuntikkan. Test ini memastikan versi final membedakan keduanya.
    """
    padat = _cluster("P", (-6.20, 106.80), 8, step=0.0001)  # nyaris bertumpuk
    jauh_pasti  = [_toko("FAR", -6.20 + 0.30, 106.80)]        # ~33 km, harus kepotong
    jauh_borderline = [_toko("NEAR", -6.20 + 0.04, 106.80)]   # ~4.4 km, di bawah ambang

    with_far  = contiguity_score(padat + jauh_pasti)
    with_near = contiguity_score(padat + jauh_borderline)

    assert with_far["n_islands"] == 2, "gap yang sungguh jauh tetap harus terdeteksi"
    assert with_near["n_islands"] == 1, "gap di bawah ambang mutlak tak boleh terpengaruh derau"


# ---------------------------------------------------------------------------
# Integrasi ke build_summary — TIDAK memaksa, hanya melapor
# ---------------------------------------------------------------------------

class _Row:
    """Objek minimal yang dibutuhkan build_summary: customer_code,
    sales_person_name, day_index."""
    def __init__(self, code, sales, day=1):
        self.customer_code = code
        self.sales_person_name = sales
        self.day_index = day


def test_build_summary_melapor_tanpa_menolak_apapun():
    """Teritori dengan gap NYATA tetap masuk build_summary tanpa exception --
    engine merekomendasikan, manusia menilai peta."""
    blob_a = _cluster("A", (-6.20, 106.80), 4)
    blob_b = _cluster("B", (-6.90, 107.60), 4)
    stores = blob_a + blob_b
    store_index = {s.customer_code: s for s in stores}
    rows = [_Row(s.customer_code, "SLS-01") for s in stores]

    summary = build_summary(rows, store_index)

    assert len(summary["per_sales"]) == 1
    entry = summary["per_sales"][0]
    assert "contiguity" in entry
    assert entry["contiguity"]["n_islands"] == 2
    assert summary["imbalance"]["territories_with_gaps"] == 1


def test_build_summary_territories_with_gaps_nol_bila_semua_kompak():
    stores = _cluster("A", (-6.20, 106.80), 6) + _cluster("B", (-6.21, 106.81), 6)
    store_index = {s.customer_code: s for s in stores}
    rows = (
        [_Row(s.customer_code, "SLS-01") for s in stores[:6]]
        + [_Row(s.customer_code, "SLS-02") for s in stores[6:]]
    )
    summary = build_summary(rows, store_index)
    assert summary["imbalance"]["territories_with_gaps"] == 0
    assert all(p["contiguity"]["n_islands"] == 1 for p in summary["per_sales"])
