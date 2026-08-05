# ==============================================================================
# core/contiguity.py  —  Ukur (jangan paksa) keterhubungan geografis teritori
# ==============================================================================
#
# K-Means memberi COMPACTNESS (titik-titik saling dekat rata-rata), BUKAN
# CONTIGUITY (wilayah membentuk satu blob yang terhubung). Literatur districting
# mensyaratkan keduanya sekaligus — Bender et al. 2016 mensyaratkan teritori
# "compact AND CONNECTED"; Salazar-Aguilar menyatakan begitu connectivity masuk
# sebagai kendala keras, "clustering methods [are] not applicable" — butuh
# districting/integer-programming, bukan K-Means murni.
#
# Di Indonesia ini bukan teori: sungai, jalan tol, atau selat bisa membelah satu
# klaster K-Means jadi dua kelompok toko yang berjarak garis-lurus dekat tapi
# secara geografis terpisah (kelilingnya jauh lebih panjang dari jarak lurusnya).
#
# PRINSIP (sama seperti balance di ROADMAP §F): UKUR DAN LAPORKAN, JANGAN PAKSA
# SEBAGAI KENDALA. Memaksa connectivity butuh constrained clustering yang jauh
# lebih mahal, dan tanpa data jalan nyata (OSRM, ROADMAP §E) menentukan "terputus
# oleh apa" tetap tebakan. Menambahkannya sekarang sebagai kendala keras = presisi
# semu — sama alasannya dengan kenapa road-aware routing sengaja ditunda.
#
# METODE: minimum spanning tree (MST) atas jarak haversine. MST adalah POHON —
# fakta murni graf: memotong k sisi membelah pohon jadi TEPAT k+1 komponen,
# berapa pun panjang sisi yang dipotong dan topologinya. Jadi menghitung jumlah
# "pulau" tidak perlu struktur graf sama sekali — cukup hitung berapa sisi MST
# yang jauh lebih panjang dari sisi lain (heuristik dari validasi klaster
# single-linkage: sisi MST yang menonjol menandai jembatan antar-blob, bukan
# bagian dari satu blob).
# ==============================================================================
from __future__ import annotations

import math
from typing import List, Sequence

from .geo import haversine
from ..constants import CONTIGUITY_GAP_MULTIPLIER, CONTIGUITY_MIN_GAP_KM


def _mst_edge_lengths(stores: Sequence) -> List[float]:
    """
    Panjang sisi minimum spanning tree (km) atas jarak haversine — Prim's, O(n²).

    Deterministik: titik disortir by customer_code sebelum diolah; pada tiap
    langkah dipilih titik-belum-masuk terdekat dengan perbandingan STRICT (<),
    jadi saat seri, titik pertama dalam urutan customer_code yang menang —
    tanpa perlu tie-break eksplisit.

    Hanya PANJANG sisi yang dikembalikan, bukan endpoint-nya — cukup untuk
    menghitung jumlah komponen setelah pemotongan (lihat contiguity_score):
    memotong k sisi pada pohon SELALU menghasilkan k+1 komponen, jadi endpoint
    tidak dibutuhkan sama sekali.
    """
    pts = sorted(stores, key=lambda s: s.customer_code)
    n = len(pts)
    if n < 2:
        return []

    in_tree = [False] * n
    in_tree[0] = True
    dist = [
        haversine(pts[0].latitude, pts[0].longitude, p.latitude, p.longitude)
        for p in pts
    ]
    edges: List[float] = []

    for _ in range(n - 1):
        best_i, best_d = -1, math.inf
        for i in range(n):
            if not in_tree[i] and dist[i] < best_d:
                best_i, best_d = i, dist[i]
        edges.append(best_d)
        in_tree[best_i] = True
        for i in range(n):
            if not in_tree[i]:
                d = haversine(
                    pts[best_i].latitude, pts[best_i].longitude,
                    pts[i].latitude, pts[i].longitude,
                )
                if d < dist[i]:
                    dist[i] = d

    return edges


def contiguity_score(
    stores: Sequence,
    gap_multiplier: float = CONTIGUITY_GAP_MULTIPLIER,
    min_gap_km: float = CONTIGUITY_MIN_GAP_KM,
) -> dict:
    """
    Skor keterhubungan geografis satu kelompok toko (biasanya: satu teritori sales).

    Return {n_islands, max_gap_km, gap_ratio}:
      n_islands  : 1 = satu blob terhubung wajar. >1 = kemungkinan terbelah jadi
                   beberapa kelompok yang jauh terpisah — TANDA untuk mata
                   manusia memeriksa peta, BUKAN vonis otomatis.
      max_gap_km : sisi MST terpanjang — lompatan terjauh di dalam teritori ini.
      gap_ratio  : max_gap_km ÷ median seluruh sisi.

    METODE: sisi MST dihitung "jeda" (pulau terpisah) hanya bila LOLOS KEDUANYA:
      (a) panjangnya >= min_gap_km (mutlak), DAN
      (b) > gap_multiplier × median sisi lain di teritori ini (relatif).

    Dua percobaan sebelumnya (ambang relatif saja, lalu lompatan-rasio-terbesar)
    diverifikasi RUSAK pada data nyata dan sengaja tidak dipakai:
      - Ambang relatif saja: kepadatan yang menurun HALUS dari pusat kota ke
        pinggiran menghasilkan sisi MST yang membentang kontinu dari puluhan
        meter sampai beberapa km — median lokal jadi kecil, dan ambang relatif
        menandai puluhan sisi wajar di ujung sebaran sebagai "jeda" (459 toko
        nyata Nabati → 60+ "pulau", jelas salah; gap terjauh yang SUNGGUH
        terjadi di data ini cuma ~5 km, konsisten dari n_sales=2 sampai 20).
      - Lompatan-rasio-terbesar (tanpa syarat mutlak): rusak oleh sisi NYARIS-
        NOL dari koordinat duplikat/nyaris-duplikat (pola yang sudah ditangani
        terpisah oleh stacked_coordinate_check) — rasio ke penyebut mendekati
        nol meledak di tempat yang tak relevan secara geografis.

    Syarat (a) menutup kelemahan itu: kepadatan yang menurun halus tak pernah
    menghasilkan sisi >= min_gap_km, jadi ambang relatif hanya pernah dievaluasi
    pada sisi yang SECARA MUTLAK sudah jauh. Syarat (b) menutup kelemahan
    sebaliknya: wilayah pedesaan yang memang jarang (spacing wajar 5-10 km
    antar toko) tak dianggap terputus selama sisi-sisinya SEBANDING satu sama
    lain, bukan satu yang menonjol jauh dari sisanya.

    <3 toko: tak ada dasar pembanding yang bermakna ("median dari 1 sisi").
    Dikembalikan sebagai satu blob (n_islands=1) — dinyatakan eksplisit,
    bukan diam-diam dilewati tanpa nilai.
    """
    edges = _mst_edge_lengths(stores)
    n = len(edges)
    if n < 2:
        return {
            "n_islands":  1,
            "max_gap_km": round(max(edges, default=0.0), 3),
            "gap_ratio":  0.0,
        }

    sorted_edges = sorted(edges)
    mid = n // 2
    median = (
        sorted_edges[mid] if n % 2
        else (sorted_edges[mid - 1] + sorted_edges[mid]) / 2.0
    )

    threshold = max(min_gap_km, median * gap_multiplier)
    n_islands = 1 + sum(1 for e in edges if e > threshold)
    max_gap   = sorted_edges[-1]

    return {
        "n_islands":  n_islands,
        "max_gap_km": round(max_gap, 3),
        "gap_ratio":  round(max_gap / median, 2) if median > 0 else 0.0,
    }


__all__ = ["contiguity_score"]
