# ==============================================================================
# core/preflight.py  —  Verifikasi dependency REQUIRED saat startup
# ==============================================================================
#
# Filosofi engine berdiri di atas library numerik ini. Tidak ada tier opsional:
# bila salah satu absen, engine MENOLAK START dengan pesan jelas.
#
# Lebih baik crash keras saat boot daripada menyimpang diam-diam saat runtime
# (spec §2, Prinsip 2). Dipanggil di api.py SEBELUM mengimpor engine, agar
# kegagalan tampil sebagai pesan ini — bukan ImportError mentah dari modul engine.
# ==============================================================================
from __future__ import annotations

import importlib
from typing import List, Tuple

# (nama paket pip, nama modul import, alasan dibutuhkan)
REQUIRED: List[Tuple[str, str, str]] = [
    ("numpy",               "numpy",               "komputasi koordinat (partition, biweekly)"),
    ("scikit-learn",        "sklearn",             "KMeans 2-cluster biweekly M2"),
    ("k-means-constrained", "k_means_constrained", "partisi sales terbalance Stage 1"),
]


def verify_dependencies() -> None:
    """
    Pastikan semua dependency REQUIRED bisa di-import.
    Raise RuntimeError dengan daftar yang hilang bila ada yang absen.
    """
    missing: List[str] = []
    for pkg, module, reason in REQUIRED:
        try:
            importlib.import_module(module)
        except Exception as e:  # ImportError dan turunannya
            missing.append(
                f"  - {pkg} (import '{module}') — {reason}"
                f"  [{type(e).__name__}: {e}]"
            )

    if missing:
        raise RuntimeError(
            "Dependency REQUIRED tidak lengkap — engine MENOLAK START.\n"
            "Filosofi engine menuntut library ini ada; tidak ada fallback senyap.\n"
            "Pasang dengan: pip install -r route_engine/requirements.txt\n\n"
            "Hilang:\n" + "\n".join(missing)
        )


__all__ = ["verify_dependencies", "REQUIRED"]
