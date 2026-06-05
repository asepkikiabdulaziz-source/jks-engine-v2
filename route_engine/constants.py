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


def day_name(day_index_zero_based: int) -> str:
    """Index 0-based → nama hari (wrap 7)."""
    return DAY_NAMES.get(day_index_zero_based % 7, "Senin")


__all__ = [
    "DAY_NAMES", "DEFAULT_RANDOM_STATE",
    "STACKED_RADIUS_M", "STACKED_MIN_COUNT",
    "BALANCE_TOLERANCE",
    "day_name",
]
