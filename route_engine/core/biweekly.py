# ==============================================================================
# core/biweekly.py  —  Pola 6×2: split ganjil/genap untuk cycle M2
# ==============================================================================
#
# Algoritma: K-Means 2-cluster pada koordinat lat/lon.
# Toko dalam satu blok (sales, hari) dibagi 2 klaster geografis:
#   Klaster 0 → ganjil = True
#   Klaster 1 → genap  = True
#   WEEKLY    → ganjil = True DAN genap = True (kunjungi tiap minggu)
#
# Mengapa K-Means bukan selang-seling tur?
#   Selang-seling tur menghasilkan sebaran merata tapi MIXED secara geografis
#   → sulit divisualisasi → sulit diverifikasi manajer.
#   K-Means memberikan klaster geografis yang jelas sehingga manajer bisa
#   melihat di peta bahwa minggu ganjil ≈ area A, minggu genap ≈ area B.
#
# Deterministik: random_state=42 + init="k-means++" → output stabil.
# ==============================================================================
from __future__ import annotations

from typing import Dict, Sequence, Tuple

import numpy as np
from sklearn.cluster import KMeans

from ..models import VisitFrequency


def split_ganjil_genap(
    ordered_stores: Sequence,
) -> Dict[str, Tuple[bool, bool]]:
    """
    Return {customer_code -> (visit_ganjil, visit_genap)} untuk cycle M2.

    Gunakan K-Means 2-cluster pada koordinat (lat, lon) agar ganjil/genap
    terpisah secara geografis dan mudah diverifikasi di peta.
    """
    out: Dict[str, Tuple[bool, bool]] = {}

    # Pisahkan WEEKLY (tiap minggu) vs BIWEEKLY (2 minggu sekali)
    biweekly = [s for s in ordered_stores
                if s.visit_frequency != VisitFrequency.WEEKLY]
    weekly   = [s for s in ordered_stores
                if s.visit_frequency == VisitFrequency.WEEKLY]

    # WEEKLY: kunjungi tiap minggu → keduanya True
    for s in weekly:
        out[s.customer_code] = (True, True)

    if not biweekly:
        return out

    # Edge case: 1 toko → langsung ganjil
    if len(biweekly) == 1:
        out[biweekly[0].customer_code] = (True, False)
        return out

    # K-Means 2-cluster pada lat/lon (deterministik)
    coords = np.array([[s.latitude, s.longitude] for s in biweekly])
    km = KMeans(n_clusters=2, n_init=10, random_state=42)
    labels = km.fit_predict(coords)

    # Assign: label 0 → ganjil, label 1 → genap
    for s, label in zip(biweekly, labels):
        if label == 0:
            out[s.customer_code] = (True,  False)  # pekan ganjil
        else:
            out[s.customer_code] = (False, True)   # pekan genap

    return out


__all__ = ["split_ganjil_genap"]
