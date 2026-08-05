#!/usr/bin/env python3
"""
import_codab.py — Impor batas administrasi COD-AB (ADM4) ke jks_engine.admin_regions

Pengganti import_gadm.py. Alasan pindah dari GADM ada di
supabase/migrations/0007_admin_regions_codab.sql (ringkas: GADM melarang
penggunaan komersial; COD-AB CC BY 3.0 IGO dan lebih lengkap).

    python scripts/import_codab.py <path>/idn_admin4.shp

Data: https://data.humdata.org/dataset/cod-ab-idn
  Unduh "idn_admin_boundaries.shp.zip" (±475 MB), ekstrak, pakai layer ADM4.
  Lisensi CC BY 3.0 IGO -- atribusi WAJIB ditampilkan di produk.

Prasyarat:
    pip install geopandas shapely supabase
    Migrasi 0007 sudah diterapkan (tabel + RPC impor).
    SUPABASE_SERVICE_ROLE_KEY di .env.local.

Fail-loud: kolom hilang / geometri rusak / batch gagal DILAPORKAN dan
menghentikan proses. Tidak ada impor separuh yang lolos diam-diam.
"""
from __future__ import annotations

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


# ── Config ────────────────────────────────────────────────────────────────────
BATCH_SIZE   = 200      # index dibiarkan hidup; 200 aman & sudah terbukti di GADM
SIMPLIFY_TOL = 0.001    # 0.001deg ~ 111 m. Sama dgn impor GADM supaya perbandingan
                        # geocoding lama-vs-baru adil (beda hasil = beda DATA,
                        # bukan beda tingkat simplifikasi).

# Kolom COD-AB ADM4 -- diverifikasi dari idn_admin_boundaries.xlsx, sheet idn_admin4
REQUIRED = [
    "adm1_name", "adm2_name", "adm3_name", "adm4_name",
    "adm0_pcode", "adm1_pcode", "adm2_pcode", "adm3_pcode", "adm4_pcode",
]
OPTIONAL = ["area_sqkm", "center_lat", "center_lon", "version", "valid_on"]


class ImportError_(SystemExit):
    """Berhenti dengan pesan yang bisa ditindaklanjuti, bukan traceback."""


def load_env(path: str) -> dict:
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def to_multipolygon(geom):
    from shapely.geometry import MultiPolygon, Polygon
    if geom is None:
        return None
    if isinstance(geom, Polygon):
        return MultiPolygon([geom])
    if isinstance(geom, MultiPolygon):
        return geom
    return None


def progress(done: int, total: int, t0: float) -> None:
    pct = done / total * 100 if total else 0
    elapsed = time.time() - t0
    eta = (elapsed / max(done, 1)) * (total - done)
    bar = "#" * int(30 * done / max(total, 1)) + "-" * (30 - int(30 * done / max(total, 1)))
    print(f"\r  [{bar}] {done:,}/{total:,} ({pct:.1f}%) ETA {eta:.0f}s  ", end="", flush=True)


def main() -> None:
    if len(sys.argv) < 2:
        raise ImportError_(
            "Path shapefile ADM4 wajib diberikan.\n"
            "  python scripts/import_codab.py <path>/idn_admin4.shp\n"
            "Unduh: https://data.humdata.org/dataset/cod-ab-idn (idn_admin_boundaries.shp.zip)"
        )
    shp = sys.argv[1]
    if not os.path.exists(shp):
        raise ImportError_(f"Shapefile tidak ditemukan: {shp}")

    env = load_env(os.path.join(ROOT, ".env.local"))
    url = (env.get("SUPABASE_URL") or env.get("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise ImportError_(
            "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak ada di .env.local.\n"
            "Impor memakai service_role -- RPC-nya sengaja ditolak utk anon & authenticated (0007)."
        )

    print("=" * 64)
    print("  COD-AB ADM4 (BPS via OCHA/HDX)  ->  jks_engine.admin_regions")
    print("  Lisensi CC BY 3.0 IGO -- atribusi wajib ditampilkan di produk")
    print("=" * 64)
    print(f"  URL : {url}")
    print(f"  SHP : {shp}")

    print("\n[1/5] Memuat shapefile...")
    try:
        import geopandas as gpd
    except ImportError:
        raise ImportError_("geopandas belum terpasang:  pip install geopandas shapely")
    gdf = gpd.read_file(shp)
    gdf = gdf.to_crs(epsg=4326)
    total_raw = len(gdf)
    print(f"      {total_raw:,} desa/kelurahan dimuat")

    # Nama kolom shapefile bisa berbeda kapitalisasi antar rilis -- normalkan.
    lower = {c.lower(): c for c in gdf.columns}
    missing = [c for c in REQUIRED if c not in lower]
    if missing:
        raise ImportError_(
            f"Kolom wajib tidak ada: {', '.join(missing)}\n"
            f"Kolom yang terbaca: {', '.join(gdf.columns)}\n"
            "Pastikan yang dipakai layer ADM4, bukan ADM0-ADM3."
        )
    if total_raw < 70000:
        print(f"      [!] Hanya {total_raw:,} baris. COD-AB ADM4 Indonesia = 81.912.")
        print("          Kemungkinan ini layer yang salah, atau ekstrak sebagian.")

    print(f"\n[2/5] Menyederhanakan geometri (tol={SIMPLIFY_TOL} ~ 111 m)...")
    gdf["geometry"] = (
        gdf["geometry"].simplify(SIMPLIFY_TOL, preserve_topology=True).apply(to_multipolygon)
    )
    before = len(gdf)
    gdf = gdf[gdf["geometry"].notna()].copy()
    if before - len(gdf):
        print(f"      [!] {before - len(gdf)} baris geometri tak terpakai dibuang")
    print(f"      {len(gdf):,} geometri valid")

    print("\n[3/5] Menyambung ke Supabase (service_role)...")
    from supabase import create_client
    sb = create_client(url, key)
    print("      Tersambung")

    print("\n[4/5] Mengosongkan tabel...")
    sb.rpc("truncate_admin_regions", {}).execute()
    print("      Kosong")

    total = len(gdf)
    print(f"\n[5/5] Menyisipkan {total:,} baris (batch={BATCH_SIZE})...")

    def val(row, name, default=""):
        col = lower.get(name)
        if not col:
            return default
        v = row.get(col)
        return default if v is None else v

    records = gdf.to_dict("records")
    inserted, failed = 0, 0
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
        try:
            sb.rpc("import_admin_regions_batch", {"p_rows": batch}).execute()
            inserted += len(batch)
        except Exception as exc:
            failed += 1
            print(f"\n  [!] Batch {i // BATCH_SIZE + 1} gagal: {str(exc)[:120]}")
            if failed >= 3:
                raise ImportError_(
                    "\n3 batch gagal berturut-turut -- dihentikan.\n"
                    "Tabel sekarang terisi SEBAGIAN. Perbaiki penyebabnya lalu jalankan ulang "
                    "(skrip meng-truncate di awal, jadi aman diulang)."
                )
        progress(min(inserted, total), total, t0)

    print(f"\n\n{'=' * 64}")
    print(f"  Selesai dalam {time.time() - t0:.0f} detik")
    print(f"  Tersisip     : {inserted:,} / {total:,}")
    print(f"  Batch gagal  : {failed}")
    print(f"{'=' * 64}")
    if inserted < total:
        raise ImportError_(
            f"Hanya {inserted:,} dari {total:,} baris masuk. JANGAN cutover -- "
            "tabel tidak lengkap."
        )
    print("\nLangkah berikutnya: jalankan kueri VERIFIKASI di bagian bawah")
    print("supabase/migrations/0007_admin_regions_codab.sql sebelum cutover.")


if __name__ == "__main__":
    main()
