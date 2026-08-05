#!/usr/bin/env python3
"""
seed_admin_regions_local.py — Isi admin_regions di DB LOKAL dengan COD-AB nyata.

⚠️ LOKAL-DEV SAJA. Bukan pengganti scripts/import_codab.py untuk DB Supabase
sungguhan (yang pakai supabase-py + RPC via PostgREST). Kontainer Postgres+
PostGIS polos tak punya PostgREST, jadi skrip ini menyambung LANGSUNG via
psycopg2 dan memanggil fungsi SQL public.import_admin_regions_batch() secara
langsung -- FUNGSI YANG SAMA PERSIS dari migrasi 0007, cuma jalur panggilannya
beda (SQL langsung vs RPC HTTP). Hasil di tabel identik; ini menguji fungsinya
sungguhan, bukan cuma menyimulasikannya.

Pakai:
    SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:55441/postgres \\
      python scripts/local-dev/seed_admin_regions_local.py <path>/idn_admin_boundaries.gdb
"""
from __future__ import annotations

import json
import os
import sys
import time

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

BATCH_SIZE = 500  # lebih besar dari import_codab.py (200) -- psycopg2 langsung,
                   # tanpa overhead HTTP per panggilan, batch lebih besar aman.


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Pakai: seed_admin_regions_local.py <path>/idn_admin_boundaries.gdb")
    gdb_path = sys.argv[1]

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        raise SystemExit("SUPABASE_DB_URL wajib di-set (arahkan ke DB LOKAL, bukan prod!)")
    if "localhost" not in db_url and "127.0.0.1" not in db_url:
        raise SystemExit(
            f"SUPABASE_DB_URL tidak menunjuk localhost: {db_url}\n"
            "Skrip ini LOKAL-DEV SAJA -- berhenti demi keamanan, bukan menebak niatmu."
        )

    print("[1/4] Memuat geodatabase (layer idn_admin4)...")
    import geopandas as gpd
    gdf = gpd.read_file(gdb_path, layer="idn_admin4")
    if gdf.crs is None or gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)
    print(f"      {len(gdf):,} desa/kelurahan dimuat")

    lower = {c.lower(): c for c in gdf.columns}

    def val(row, name, default=""):
        col = lower.get(name)
        v = row.get(col) if col else None
        return default if v is None else v

    print("\n[2/4] Menyambung ke DB lokal via psycopg2...")
    import psycopg2
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor()
    print("      Tersambung")

    print("\n[3/4] Mengosongkan admin_regions...")
    cur.execute("select public.truncate_admin_regions()")
    conn.commit()

    total = len(gdf)
    print(f"\n[4/4] Menyisipkan {total:,} baris via public.import_admin_regions_batch (batch={BATCH_SIZE})...")
    records = gdf.to_dict("records")
    inserted = 0
    t0 = time.time()

    for i in range(0, len(records), BATCH_SIZE):
        batch = []
        for row in records[i:i + BATCH_SIZE]:
            geom = row.get("geometry")
            if geom is None:
                continue
            valid_on = str(val(row, "valid_on", ""))[:10]
            batch.append({
                "adm1_name": str(val(row, "adm1_name")),
                "adm2_name": str(val(row, "adm2_name")),
                "adm3_name": str(val(row, "adm3_name")),
                "adm4_name": str(val(row, "adm4_name")),
                "adm0_pcode": str(val(row, "adm0_pcode")),
                "adm1_pcode": str(val(row, "adm1_pcode")),
                "adm2_pcode": str(val(row, "adm2_pcode")),
                "adm3_pcode": str(val(row, "adm3_pcode")),
                "adm4_pcode": str(val(row, "adm4_pcode")),
                "area_sqkm": str(val(row, "area_sqkm")),
                "center_lat": str(val(row, "center_lat")),
                "center_lon": str(val(row, "center_lon")),
                "source_version": str(val(row, "version")),
                "valid_on": valid_on if valid_on[:4].isdigit() else "",
                "wkt": geom.wkt,
            })
        if not batch:
            continue
        cur.execute(
            "select public.import_admin_regions_batch(%s::jsonb)",
            (json.dumps(batch),),
        )
        inserted += cur.fetchone()[0]
        conn.commit()
        print(f"\r      {min(i + BATCH_SIZE, total):,}/{total:,}", end="", flush=True)

    print(f"\n\nSelesai dalam {time.time() - t0:.0f} detik. Tersisip: {inserted:,} baris.")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
