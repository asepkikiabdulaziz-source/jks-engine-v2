# ==============================================================================
# constants.py
# ==============================================================================
from __future__ import annotations

DAY_NAMES = {
    0: "Senin",
    1: "Selasa",
    2: "Rabu",
    3: "Kamis",
    4: "Jumat",
    5: "Sabtu",
    6: "Minggu",
}

DEFAULT_RANDOM_STATE = 42

# QC: tumpukan koordinat rapat
STACKED_RADIUS_M  = 10.0   # radius "tumpukan tidak wajar" (meter)
STACKED_MIN_COUNT = 3      # minimal K toko dalam radius → di-flag

# Toleransi kerataan jumlah antar-sales (±10%)
BALANCE_TOLERANCE = 0.10

# Contiguity (core/contiguity.py): sisi minimum-spanning-tree dihitung "pulau"
# terpisah HANYA bila LOLOS KEDUANYA — mutlak DAN relatif:
#   (a) >= CONTIGUITY_MIN_GAP_KM,             DAN
#   (b) >  CONTIGUITY_GAP_MULTIPLIER × median sisi lain di teritori itu.
# Dua syarat ini saling menutup kelemahan masing-masing:
#  - Tanpa (a): kepadatan yang menurun HALUS dari pusat kota ke pinggiran punya
#    sisi MST yang membentang kontinu dari puluhan meter sampai beberapa km —
#    ambang relatif SAJA menandai puluhan sisi wajar sebagai "jeda" (diverifikasi
#    thd 2.293 toko nyata Nabati: 459 toko → 60-136 "pulau" versi awal, jelas
#    salah; gap terbesar yang sungguh terjadi di data ini cuma ~5 km, di SEMUA
#    ukuran teritori dari n_sales=2 sampai 20).
#  - Tanpa (b): daerah pedesaan yang memang jarang (spacing wajar 5-10 km antar
#    toko) akan selalu dianggap "terputus" walau sebenarnya satu wilayah homogen.
# 5.0 km dipilih dari data nyata di atas (batas atas gap alami ≈ 4,98 km,
# konsisten lintas ukuran teritori) + akal sehat FMCG Jawa: di atas itu bukan
# lagi "toko di ujung wilayah", tapi "toko di wilayah lain".
CONTIGUITY_MIN_GAP_KM     = 5.0
CONTIGUITY_GAP_MULTIPLIER = 3.0


def day_name(day_index_zero_based: int) -> str:
    """Index 0-based → nama hari (wrap 7)."""
    return DAY_NAMES.get(day_index_zero_based % 7, "Senin")


__all__ = [
    "DAY_NAMES", "DEFAULT_RANDOM_STATE",
    "STACKED_RADIUS_M", "STACKED_MIN_COUNT",
    "BALANCE_TOLERANCE", "CONTIGUITY_MIN_GAP_KM", "CONTIGUITY_GAP_MULTIPLIER",
    "day_name",
]
