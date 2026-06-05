"""
start_engine.py — Dev startup script.
Load credentials dari .env.local, start FastAPI engine di port 8000.

Usage:
    python start_engine.py

CATATAN Windows: uvicorn --reload pakai multiprocessing yang butuh
if __name__ == '__main__' guard. Tanpa ini → RuntimeError saat spawn.
"""
import os
import sys
from pathlib import Path


def _load_env() -> None:
    """Load .env.local via python-dotenv, map nama variabel ke yang dibutuhkan api.py."""
    try:
        from dotenv import load_dotenv
        env_file = Path(__file__).parent / ".env.local"
        if env_file.exists():
            load_dotenv(env_file, override=False)   # override=False: jangan tindih env OS
            print(f"[engine] Loaded {env_file}")
        else:
            print(f"[engine] WARNING: {env_file} tidak ditemukan", file=sys.stderr)
    except ImportError:
        print("[engine] WARNING: python-dotenv tidak terinstall", file=sys.stderr)

    # .env.local pakai NEXT_PUBLIC_SUPABASE_URL; api.py butuh SUPABASE_URL
    if not os.environ.get("SUPABASE_URL"):
        os.environ["SUPABASE_URL"] = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")

    # .env.local pakai SUPABASE_SERVICE_ROLE_KEY; api.py butuh SUPABASE_SERVICE_KEY
    if not os.environ.get("SUPABASE_SERVICE_KEY"):
        os.environ["SUPABASE_SERVICE_KEY"] = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    # Validasi
    missing = [v for v in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(v)]
    if missing:
        print(f"[engine] ERROR: env vars tidak ditemukan: {missing}", file=sys.stderr)
        sys.exit(1)

    key_tail = "***" + os.environ["SUPABASE_SERVICE_KEY"][-6:]
    print(f"[engine] SUPABASE_URL  = {os.environ['SUPABASE_URL']}")
    print(f"[engine] SERVICE_KEY   = {key_tail}")


# ── Wajib untuk Windows multiprocessing (uvicorn --reload) ────────────────────
if __name__ == "__main__":
    _load_env()

    import uvicorn
    uvicorn.run(
        "api:app",          # api.py ada di root project (bukan route_engine/)
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
