"""
run_migrations.py — Runner migrasi minimal untuk JKS (pola sama dgn nabati-heroes: file
bernomor di supabase/migrations/, ledger jks_engine._migrations, apply berurutan).

Bukan alat operasional harian ke prod tanpa review — jalankan manual, baca output tiap file
sebelum lanjut. Tak ada rollback otomatis; migrasi harus idempoten (`if not exists`, dst).

Usage:
    python scripts/run_migrations.py            # apply migrasi yang belum tercatat
    python scripts/run_migrations.py --dry-run  # tampilkan yang AKAN dijalankan, tanpa eksekusi
"""
import os
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).parent.parent
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"


def load_db_url() -> str:
    # Env var didahulukan -- dipakai utk mengarahkan runner ke DB LOKAL (docker,
    # lihat scripts/local-dev/) tanpa pernah membaca atau menyentuh .env.local
    # (yang berisi kredensial DB BERSAMA/prod). Tanpa jalur ini, satu-satunya
    # cara menguji migrasi secara lokal adalah menimpa .env.local sementara --
    # berisiko lupa dikembalikan sebelum migrasi berikutnya dijalankan sungguhan.
    if os.environ.get("SUPABASE_DB_URL"):
        return os.environ["SUPABASE_DB_URL"]
    env_file = ROOT / ".env.local"
    for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("SUPABASE_DB_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("SUPABASE_DB_URL tidak ditemukan di .env.local (atau env var)")


def main():
    dry_run = "--dry-run" in sys.argv
    conn = psycopg2.connect(load_db_url())
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute("select to_regclass('jks_engine._migrations')")
    if cur.fetchone()[0] is None:
        raise SystemExit(
            "jks_engine._migrations belum ada. Jalankan 0002_migrations_ledger.sql dulu "
            "(manual, sekali) sebelum memakai runner ini."
        )

    cur.execute("select filename from jks_engine._migrations")
    applied = {r[0] for r in cur.fetchall()}

    pending = sorted(
        f for f in MIGRATIONS_DIR.glob("*.sql") if f.name not in applied
    )

    if not pending:
        print("Tidak ada migrasi pending.")
        return

    for f in pending:
        print(f"{'[DRY-RUN] akan menjalankan' if dry_run else '>>> menjalankan'}: {f.name}")
        if dry_run:
            continue
        sql = f.read_text(encoding="utf-8")
        try:
            cur.execute(sql)
            cur.execute(
                "insert into jks_engine._migrations (filename) values (%s)", (f.name,)
            )
            conn.commit()
            print(f"    OK — {f.name} diterapkan & dicatat.")
        except Exception as e:
            conn.rollback()
            print(f"    GAGAL — {f.name}: {e}", file=sys.stderr)
            print("    Berhenti; migrasi setelahnya TIDAK dijalankan.", file=sys.stderr)
            sys.exit(1)

    conn.close()


if __name__ == "__main__":
    main()
