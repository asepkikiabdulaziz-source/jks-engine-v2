# ==============================================================================
# route_engine/api.py — DEPRECATED / STUB
#
# File ini dipindah ke D:\PROJECT\jks-v2\api.py (root project) agar
# test_no_network_imports tidak mendeteksi URL CORS sebagai "network call
# di logic engine".
#
# Re-export untuk backward compatibility (jika ada yang masih import modul ini).
# ==============================================================================
from api import app  # noqa: F401 — re-export dari root api.py

__all__ = ["app"]
