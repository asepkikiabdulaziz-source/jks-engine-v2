"""
dump_baseline.py — Generate DDL baseline dari DB live (pengganti pg_dump, yang tidak
terpasang di mesin ini). Baca SUPABASE_DB_URL dari .env.local, tulis
supabase/migrations/0001_baseline.sql.

Cakupan: tabel schema jks_engine (kolom, PK, FK, unique, index, RLS policy) + definisi
seluruh RPC JKS yang saat ini tinggal di public (akan pindah ke schema `jks` nanti).

Usage: python scripts/dump_baseline.py
"""
import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).parent.parent

JKS_ENGINE_TABLES = [
    "access_roles", "gadm_kecamatan", "gadm_provinsi", "gadm_regions",
    "plan_assignments", "plans", "stores", "stores_staging",
]

# 17 RPC JKS + utilitas GADM — semua saat ini fisik di schema `public`.
JKS_PUBLIC_FUNCTIONS = [
    "get_my_profile", "get_routing_regions", "get_routing_cabangs", "get_routing_areas",
    "get_stores_by_area", "get_plans_by_area", "get_plan_assignments", "save_plan",
    "next_plan_version", "approve_plan", "discard_plan", "stage_stores",
    "commit_staging", "discard_staging", "get_plan_coverage_summary", "upsert_stores",
    "preview_geocode_summary", "import_gadm_batch", "truncate_gadm_regions",
]

JKS_ENGINE_FUNCTIONS = ["set_updated_at"]


def load_db_url() -> str:
    env_file = ROOT / ".env.local"
    for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("SUPABASE_DB_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("SUPABASE_DB_URL tidak ditemukan di .env.local")


def dump_table_ddl(cur, schema: str, table: str) -> str:
    cur.execute("""
        select column_name, data_type, udt_name, is_nullable, column_default,
               character_maximum_length, numeric_precision, numeric_scale
          from information_schema.columns
         where table_schema=%s and table_name=%s
         order by ordinal_position
    """, (schema, table))
    cols = cur.fetchall()
    if not cols:
        return f"-- ⚠️ tabel {schema}.{table} tidak ditemukan (skip)\n"

    lines = [f"create table if not exists {schema}.{table} ("]
    col_defs = []
    for name, data_type, udt, nullable, default, maxlen, prec, scale in cols:
        if data_type == "USER-DEFINED":
            typ = udt
        elif data_type == "ARRAY":
            typ = udt.lstrip("_") + "[]"
        elif data_type == "character varying" and maxlen:
            typ = f"varchar({maxlen})"
        elif data_type == "numeric" and prec is not None:
            typ = f"numeric({prec},{scale or 0})"
        else:
            typ = data_type
        col_line = f"  {name} {typ}"
        if nullable == "NO":
            col_line += " not null"
        if default is not None:
            col_line += f" default {default}"
        col_defs.append(col_line)
    lines.append(",\n".join(col_defs))
    lines.append(");")

    # Constraints (PK, FK, UNIQUE, CHECK)
    cur.execute("""
        select conname, pg_get_constraintdef(oid)
          from pg_constraint
         where conrelid = (%s || '.' || %s)::regclass
         order by contype
    """, (schema, table))
    for name, defn in cur.fetchall():
        lines.append(
            f"alter table {schema}.{table} add constraint {name} {defn};"
        )

    # Indexes (selain yang dari constraint di atas)
    cur.execute("""
        select indexname, indexdef from pg_indexes
         where schemaname=%s and tablename=%s
    """, (schema, table))
    for idxname, idxdef in cur.fetchall():
        cur.execute("""
            select 1 from pg_constraint
             where conrelid = (%s || '.' || %s)::regclass and conname = %s
        """, (schema, table, idxname))
        if not cur.fetchone():
            lines.append(idxdef + ";")

    # RLS policies
    cur.execute("""
        select polname, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid),
               polcmd, array_to_string(polroles::regrole[], ',')
          from pg_policy where polrelid = (%s || '.' || %s)::regclass
    """, (schema, table))
    for polname, qual, check, cmd, roles_str in cur.fetchall():
        cmd_sql = {"r": "select", "a": "insert", "w": "update", "d": "delete", "*": "all"}.get(cmd, "all")
        role_sql = roles_str if roles_str else "public"
        clause = f" using ({qual})" if qual else ""
        clause += f" with check ({check})" if check else ""
        lines.append(
            f'create policy "{polname}" on {schema}.{table} for {cmd_sql} to {role_sql}{clause};'
        )

    cur.execute("select relrowsecurity from pg_class where oid = (%s||'.'||%s)::regclass", (schema, table))
    rls = cur.fetchone()
    if rls and rls[0]:
        lines.append(f"alter table {schema}.{table} enable row level security;")

    return "\n".join(lines) + "\n"


def dump_function_ddl(cur, schema: str, name: str) -> str:
    cur.execute("""
        select p.oid, pg_get_function_identity_arguments(p.oid)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname=%s and p.proname=%s
    """, (schema, name))
    rows = cur.fetchall()
    if not rows:
        return f"-- ⚠️ fungsi {schema}.{name} tidak ditemukan (skip)\n"
    out = []
    for oid, args in rows:
        cur.execute("select pg_get_functiondef(%s)", (oid,))
        out.append(cur.fetchone()[0] + ";")
    return "\n".join(out) + "\n"


def main():
    conn = psycopg2.connect(load_db_url())
    conn.set_session(readonly=True, autocommit=True)
    cur = conn.cursor()

    parts = [
        "-- 0001_baseline.sql — snapshot skema jks_engine + RPC JKS dari DB live.",
        "-- Dibangkitkan otomatis via scripts/dump_baseline.py (pg_dump tidak tersedia di mesin dev).",
        "-- Ini SNAPSHOT titik-waktu, bukan migrasi inkremental — jangan re-run ke DB yang sudah punya objeknya",
        "-- tanpa DROP dulu. Tujuan: project bisa direkonstruksi dari git, bukan operasional harian.",
        "--",
        "-- ⚠️ CLEAN-ROOM REPLAY: access_roles.job_title_id FK ke mst_hr.positions(id) (schema Heroes).",
        "-- Di DB kosong/shadow, replay ini GAGAL kecuali mst_hr.positions sudah ada — sama seperti",
        "-- masalah yang Heroes selesaikan dgn shim 0169_jks_engine_shim_for_replay.sql utk jks_engine.",
        "-- Belum ada shim serupa dari sisi kita untuk dependency ini.",
        "",
        "create schema if not exists jks_engine;",
        "",
        "-- ============================================================",
        "-- TABEL jks_engine",
        "-- ============================================================",
    ]
    for t in JKS_ENGINE_TABLES:
        parts.append(f"\n-- --- {t} ---")
        parts.append(dump_table_ddl(cur, "jks_engine", t))

    parts.append("\n-- ============================================================")
    parts.append("-- FUNGSI jks_engine")
    parts.append("-- ============================================================")
    for f in JKS_ENGINE_FUNCTIONS:
        parts.append(f"\n-- --- {f} ---")
        parts.append(dump_function_ddl(cur, "jks_engine", f))

    parts.append("\n-- ============================================================")
    parts.append("-- RPC JKS (fisik masih di public — akan pindah ke schema `jks`, lihat ROADMAP)")
    parts.append("-- ============================================================")
    for f in JKS_PUBLIC_FUNCTIONS:
        parts.append(f"\n-- --- public.{f} ---")
        parts.append(dump_function_ddl(cur, "public", f))

    conn.close()

    out_path = ROOT / "supabase" / "migrations" / "0001_baseline.sql"
    out_path.write_text("\n".join(parts), encoding="utf-8")
    print(f"Ditulis: {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
