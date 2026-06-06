#!/usr/bin/env python3
"""
import_gadm.py — Import GADM Level 4 Indonesia ke Supabase
Jalankan dari root project: D:\\PROJECT\\jks-v2\\

    python scripts/import_gadm.py [/path/to/gadm41_IDN_4.shp]

Jika path SHP tidak diberikan, default ke: <project_root>/referensi/gadm41_IDN_shp/gadm41_IDN_4.shp

Requirements:
    pip install geopandas supabase shapely
Credentials dibaca dari .env.local (SUPABASE_SERVICE_ROLE_KEY).

Catatan: Script ini one-time setup. Data GADM sudah ada di Supabase.
Jalankan ulang hanya jika perlu reimport (perubahan simplifikasi, skema baru, dst).
"""

import os
import sys
import json
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Baca credentials dari .env.local ──────────────────────────
def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env

env = load_env(os.path.join(ROOT, '.env.local'))
SUPABASE_URL = env.get('NEXT_PUBLIC_SUPABASE_URL', '').rstrip('/')
SVC_KEY      = env.get('SUPABASE_SERVICE_ROLE_KEY', '')

if not SUPABASE_URL or not SVC_KEY:
    print("❌  SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY tidak ditemukan di .env.local")
    sys.exit(1)

# ── Config ─────────────────────────────────────────────────────
# Path SHP bisa diberikan via argumen CLI atau env var GADM_SHP_PATH
_default_shp = os.path.join(ROOT, 'referensi', 'gadm41_IDN_shp', 'gadm41_IDN_4.shp')
SHP_PATH     = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('GADM_SHP_PATH', _default_shp)
BATCH_SIZE   = 200       # rows per RPC call — index di-drop sebelum import, jadi bisa lebih besar
SIMPLIFY_TOL = 0.001     # 0.001° ≈ 111m — jauh lebih akurat dari 0.005°, celah ditutup KNN fallback


# ── Helpers ────────────────────────────────────────────────────
def to_multipolygon(geom):
    from shapely.geometry import MultiPolygon, Polygon
    if geom is None:
        return None
    if isinstance(geom, Polygon):
        return MultiPolygon([geom])
    if isinstance(geom, MultiPolygon):
        return geom
    return None


def progress(done, total, t0):
    pct     = done / total * 100
    elapsed = time.time() - t0
    eta     = (elapsed / max(done, 1)) * (total - done)
    bar     = '#' * int(30 * done / total) + '-' * (30 - int(30 * done / total))
    print(f'\r  [{bar}] {done:,}/{total:,} ({pct:.1f}%) ETA {eta:.0f}s  ',
          end='', flush=True)


# ── Main ────────────────────────────────────────────────────────
def main():
    print('=' * 60)
    print('  JKS - GADM Level 4 Indonesia -> Supabase')
    print('=' * 60)
    print(f'  URL : {SUPABASE_URL}')
    print(f'  SHP : {SHP_PATH}')

    if not os.path.exists(SHP_PATH):
        print(f'\n❌  Shapefile tidak ditemukan: {SHP_PATH}')
        sys.exit(1)

    # 1. Load shapefile
    print('\n[1/5] Loading shapefile...')
    import geopandas as gpd
    gdf = gpd.read_file(SHP_PATH)
    gdf = gdf.to_crs(epsg=4326)
    total_raw = len(gdf)
    print(f'      {total_raw:,} kelurahan/desa dimuat')

    required_cols = ['NAME_1', 'NAME_2', 'NAME_3', 'NAME_4',
                     'GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'TYPE_4']
    for col in required_cols:
        if col not in gdf.columns:
            print(f'\n❌  Kolom {col!r} tidak ada. Kolom: {gdf.columns.tolist()}')
            sys.exit(1)

    # 2. Validate / convert geometry (no simplification — geometry asli untuk akurasi PIP)
    print(f'\n[2/5] Memvalidasi geometri (SIMPLIFY_TOL={SIMPLIFY_TOL} = tidak disimplify)...')
    if SIMPLIFY_TOL > 0:
        gdf['geometry'] = (
            gdf['geometry']
            .simplify(SIMPLIFY_TOL, preserve_topology=True)
            .apply(to_multipolygon)
        )
    else:
        gdf['geometry'] = gdf['geometry'].apply(to_multipolygon)
    gdf = gdf[gdf['geometry'].notna()].copy()
    dropped = total_raw - len(gdf)
    if dropped:
        print(f'      ⚠  {dropped} baris geometry null dibuang')
    print(f'      {len(gdf):,} geometri valid')

    # 3. Connect Supabase
    print('\n[3/5] Connecting ke Supabase (service_role)...')
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SVC_KEY)
    print('      Connected OK')

    # 4. Truncate via RPC (jks_engine schema tidak bisa diakses via .table())
    print('\n[4/5] Membersihkan tabel lama...')
    try:
        sb.rpc('truncate_gadm_regions', {}).execute()
        print('      Tabel dikosongkan OK')
    except Exception as e:
        print(f'      [!] Truncate skip ({e}) -- lanjut insert')

    # 5. Batch insert via RPC
    total   = len(gdf)
    print(f'\n[5/5] Inserting {total:,} rows (batch={BATCH_SIZE})...')
    cols = ['NAME_1', 'NAME_2', 'NAME_3', 'NAME_4',
            'GID_0', 'GID_1', 'GID_2', 'GID_3', 'GID_4', 'TYPE_4', 'geometry']
    rows    = gdf[cols].values.tolist()
    inserted = 0
    batch_errors = 0
    t0 = time.time()

    i = 0
    while i < len(rows):
        chunk = rows[i:i + BATCH_SIZE]
        batch = []
        for r in chunk:
            geom = r[10]
            if geom is None:
                continue
            batch.append({
                'name_1': str(r[0] or ''),
                'name_2': str(r[1] or ''),
                'name_3': str(r[2] or ''),
                'name_4': str(r[3] or ''),
                'gid_0':  str(r[4] or ''),
                'gid_1':  str(r[5] or ''),
                'gid_2':  str(r[6] or ''),
                'gid_3':  str(r[7] or ''),
                'gid_4':  str(r[8] or ''),
                'type_4': str(r[9] or ''),
                'wkt':    geom.wkt,
            })

        if batch:
            try:
                sb.rpc('import_gadm_batch', {'p_rows': batch}).execute()
                inserted += len(batch)
            except Exception as e:
                batch_errors += 1
                if batch_errors <= 3:
                    print(f'\n  [!] Batch {i//BATCH_SIZE+1} error: {str(e)[:80]}')

        i += BATCH_SIZE
        progress(min(inserted, total), total, t0)

    elapsed = time.time() - t0
    print(f'\n\n{"=" * 60}')
    print(f'  SELESAI dalam {elapsed:.0f} detik')
    print(f'  Inserted      : {inserted:,}')
    print(f'  Batch errors  : {batch_errors}')
    print(f'{"=" * 60}')


if __name__ == '__main__':
    main()
