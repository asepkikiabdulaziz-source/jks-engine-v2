-- shim_external_deps.sql
-- ============================================================================
-- ⚠️ BUKAN MIGRASI RESMI. Jangan taruh di supabase/migrations/, jangan pernah
-- dijalankan lewat run_migrations.py, jangan pernah diterapkan ke DB bersama.
-- ============================================================================
--
-- jks_engine bergantung pada tabel milik nabati-heroes (auth.*, mst_hr.*,
-- mst_area.*) yang TIDAK ADA di migrasi kita sendiri -- itu milik project lain,
-- dan replay ke DB kosong akan gagal tanpa pengganti minimal untuknya. Ini
-- dicatat sebagai utang di CLAUDE.md: "FK access_roles.job_title_id ->
-- mst_hr.positions(id) bikin replay ke DB kosong gagal tanpa shim (pola sama
-- dgn 0169_jks_engine_shim_for_replay.sql milik Heroes)".
--
-- Berkas ini adalah shim itu: pengganti MINIMAL, cukup untuk 0001-0009 apply
-- bersih dan bisa diuji fungsional (bukan cuma sintaks) di kotak pasir lokal.
-- Kolom & tipe DIVERIFIKASI cocok terhadap DB prod (information_schema, 2026-
-- 08-05), bukan ditebak.
--
-- YANG SENGAJA DISEDERHANAKAN (bukan lupa):
--   - mst_area.areas.price_zone_id TIDAK diberi FK ke price_zones -- kolomnya
--     nullable dan tak pernah dipakai logic JKS; shim tak perlu meniru tabel
--     yang tak pernah disentuh.
--   - auth.uid() ditiru via set_config('request.jwt.claim.sub', ...) --
--     PERSIS teknik yang sudah dipakai tests/test_rpc_authz.py utk simulasi
--     sesi PostgREST thd DB prod. Bukan trik baru, pola yang sudah terbukti.
--   - Tak ada auth.get_user() -- itu API Supabase Auth (dipanggil dari Python
--     via supabase-py), bukan fungsi SQL. Tak relevan untuk uji migrasi.
--
-- Pakai: docker exec -i jks-local-pg psql -U postgres -d postgres < berkas ini
-- Lalu: jalankan 0001-0009 via run_migrations.py (SUPABASE_DB_URL di-override
-- env var -- lihat catatan di scripts/run_migrations.py).
-- ============================================================================

-- ── Roles Supabase (dirujuk GRANT/REVOKE di 0003 dst.) ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- Default privileges Supabase yang justru MELAHIRKAN lubang 0006 -- direplikasi
-- di sini SUPAYA shim ini juga menangkap regresi ACL yang sama secara lokal.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ── schema auth (milik Heroes/Supabase) ───────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

-- Teknik IDENTIK dgn tests/test_rpc_authz.py::_as_member /
-- _as_anonymous_session -- set_config('request.jwt.claim.sub', <uuid>, true)
-- mensimulasikan sesi PostgREST; string kosong = anon/service_role (tanpa klaim).
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- ── schema mst_hr (milik Heroes) ──────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS mst_hr;

CREATE TABLE IF NOT EXISTS mst_hr.positions (
  id          text PRIMARY KEY,
  name        text,
  description text,
  grade_id    text
);

-- Skema PENUH -- diverifikasi thd information_schema DB prod (2026-08-05), bukan
-- cuma 3 kolom yang dipakai guard clause. RPC get_my_profile memakai jauh lebih
-- banyak (assignment_nik, branch_name, region_name, dst) -- shim awal yang cuma
-- berisi kolom guard gagal di "column saf.assignment_nik does not exist" saat
-- replay sungguhan. Tabel sesungguhnya milik Heroes JAUH lebih kaya (roster,
-- histori penugasan); shim ini hanya meniru BENTUK kolomnya, bukan isinya.
CREATE TABLE IF NOT EXISTS mst_hr.slot_assignment_flat (
  slot_code           text,
  sales_code          text,
  role_name           text,
  role_id             text,
  division_id         text,
  scope_name          text,
  scope_id            text,
  scope_type          text,
  grade               text,
  area_name           text,
  parent_slot_code    text,
  assignment_nik      text,
  assignment_start    date,
  employee_name       text,
  employee_email      text,
  employee_is_active  boolean,
  cabang_id           uuid,
  region_id           uuid,
  branch_code         text,
  branch_name         text,
  region_code         text,
  region_name         text,
  kd_dist             text,
  auth_user_id        uuid,
  company_scope       text,
  kd_company          text,
  nama_company        text
);

-- ── schema mst_area (milik Heroes) ────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS mst_area;

CREATE TABLE IF NOT EXISTS mst_area.regions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kd_region        text,
  nama_region      text,
  group_region_id  uuid,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mst_area.cabangs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kd_cabang   text,
  nama_cabang text,
  region_id   uuid REFERENCES mst_area.regions(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mst_area.ldcs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kd_ldc      text,
  nama_ldc    text,
  plant       text,
  alamat      text,
  lon         numeric,
  lat         numeric,
  is_active   boolean DEFAULT true,
  cabang_id   uuid REFERENCES mst_area.cabangs(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mst_area.areas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kd_dist        text NOT NULL,
  nama_area      text NOT NULL,
  alamat         text,
  lon            numeric,
  lat            numeric,
  singkatan1     text,
  singkatan2     text,
  is_active      boolean NOT NULL DEFAULT true,
  kd_ldc         text,
  kd_price_zone  text,
  status_code    text,
  ldc_id         uuid NOT NULL REFERENCES mst_area.ldcs(id),
  price_zone_id  uuid,   -- sengaja tanpa FK -- lihat catatan di atas
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- SEED -- cukup untuk uji fungsional end-to-end, bukan cuma "migrasi apply"
-- ============================================================================
INSERT INTO mst_hr.positions (id, name) VALUES ('000004', 'EXTERNAL_JKS')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO mst_area.regions (id, kd_region, nama_region)
  VALUES ('00000000-0000-0000-0000-000000000001', 'R01', 'Region Uji')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO mst_area.cabangs (id, kd_cabang, nama_cabang, region_id)
  VALUES ('00000000-0000-0000-0000-000000000002', 'C01', 'Cabang Uji',
          '00000000-0000-0000-0000-000000000001')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO mst_area.ldcs (id, kd_ldc, nama_ldc, cabang_id)
  VALUES ('00000000-0000-0000-0000-000000000003', 'L01', 'LDC Uji',
          '00000000-0000-0000-0000-000000000002')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO mst_area.areas (id, kd_dist, nama_area, lat, lon, ldc_id, is_active)
  VALUES ('00000000-0000-0000-0000-000000000004', '1000000', 'Area Uji',
          -6.20, 106.80, '00000000-0000-0000-0000-000000000003', true)
  ON CONFLICT (id) DO NOTHING;

-- User uji: anggota JKS aktif -- dipakai skenario "lolos guard".
INSERT INTO auth.users (id, email)
  VALUES ('11111111-1111-1111-1111-111111111111', 'admin@jks.local.test')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO mst_hr.slot_assignment_flat (
  auth_user_id, role_id, employee_is_active,
  slot_code, role_name, scope_id, scope_type, scope_name,
  assignment_nik, employee_name, branch_code, branch_name,
  region_code, region_name
) VALUES (
  '11111111-1111-1111-1111-111111111111', '000004', true,
  'R00-00-02', 'EXTERNAL_JKS', '00', 'NASIONAL', 'Nasional',
  '99999998', 'Admin Uji JKS', 'C01', 'Cabang Uji',
  'R01', 'Region Uji'
);

-- User uji kedua: PUNYA akun tapi BUKAN anggota JKS -- skenario "ditolak guard".
INSERT INTO auth.users (id, email)
  VALUES ('22222222-2222-2222-2222-222222222222', 'bukan-anggota@jks.local.test')
  ON CONFLICT (id) DO NOTHING;
