-- 0010_harden_all_rpc_acl.sql
-- Kunci ACL SELURUH 20 RPC JKS secara eksplisit -- jangan lagi bergantung pada
-- keberuntungan berbagi schema `public` dengan sapuan keamanan project lain.
--
-- ============================================================================
-- TEMUAN: PROD AMAN HARI INI SECARA KEBETULAN, BUKAN KARENA MIGRASI KITA
-- ============================================================================
-- Ditemukan 2026-08-05 saat menyiapkan DB LOKAL (Docker) untuk menguji replay
-- migrasi 0001-0009 dari nol -- pengujian yang baru pertama kali dilakukan
-- sungguhan, bukan cuma dibayangkan.
--
-- Fakta yang diverifikasi langsung ke pg_default_acl PROD:
--   default privileges schema public MEMANG menggratiskan EXECUTE ke anon utk
--   setiap fungsi baru (diset oleh role postgres & supabase_admin -- ini bagian
--   dari template project Supabase, bukan sesuatu yang JKS atur).
--
-- Lalu direplay 0001-0009 ke DB KOSONG (tanpa proteksi apa pun dari luar):
--
--   18 dari 20 RPC JKS  ->  anon = TRUE (bisa dipanggil TANPA LOGIN)
--
-- Cuma get_stores_by_area (0006) dan 2 RPC admin_regions (0007) yang aman --
-- karena KITA eksplisit menutupnya. 18 SISANYA -- termasuk save_plan,
-- stage_stores, upsert_stores, approve_plan, discard_plan -- terbuka penuh.
--
-- Prod TIDAK menunjukkan ini hari ini HANYA karena JKS menumpang schema
-- `public` milik nabati-heroes, dan mereka pernah menjalankan sapuan keamanan
-- sendiri (migrasi 0297 mereka -- lihat 0398_restore_jks_rpc_grants.sql:
-- "0297 yang memang benar dipertahankan: anon tetap DITOLAK") yang mencabut
-- anon dari SELURUH fungsi di public, RPC JKS ikut kena tanpa JKS pernah
-- memintanya. Proteksi itu bukan milik kita, tidak tercatat di migrasi kita,
-- dan tidak ada jaminan ia tetap ada selamanya (0297 sendiri pernah salah
-- sasaran ke `authenticated` sebelum diperbaiki 0398 -- bukti sapuan seperti
-- ini bisa berubah tanpa JKS diberi tahu).
--
-- KONSEKUENSI UNTUK PEMISAHAN DB: begitu 0001-0009 di-replay ke project
-- Supabase BARU (tanpa sapuan Heroes), 18 RPC itu akan LAHIR TERBUKA ke
-- internet -- jauh lebih parah dari kebocoran get_stores_by_area yang 0006
-- tutup. Migrasi ini WAJIB diterapkan SEBELUM atau BERSAMAAN dengan replay ke
-- DB manapun yang tak lagi menumpang schema Heroes -- termasuk DB baru nanti.
--
-- ============================================================================
-- KEBIJAKAN PER-RPC -- diverifikasi dari pemanggil SUNGGUHAN (grep src/,
-- api.py, scripts/), bukan ditebak. Pola sama dgn insiden 0003/0004: sebelum
-- REVOKE, pastikan siapa pemanggil sahnya, atau mengulang regresi yang sama.
-- ============================================================================
--
--  RPC                          authenticated  service_role  anon
--  ─────────────────────────────────────────────────────────────
--  get_my_profile                    v                        (browser: AuthContext.tsx)
--  get_routing_regions               v                        (browser: AreaContext.tsx)
--  get_routing_cabangs               v                        (browser: AreaContext.tsx)
--  get_routing_areas                 v                        (browser: AreaContext.tsx)
--  get_plan_assignments              v                        (browser: exportPlan.ts, PlanMapPage, DashboardPage)
--  get_plans_by_area                 v                        (browser: PlanMapPage, PlansPage, DashboardPage)
--  get_plan_coverage_summary         v                        (browser: PlanMapPage.tsx)
--  approve_plan                      v                        (browser: PlansPage.tsx)
--  discard_plan                      v                        (browser: PlansPage.tsx)
--  discard_staging                   v                        (browser: UploadTokoPage.tsx)
--  get_stores_by_area                v            v           (browser 4x + api.py 3x -- sudah 0005/0006)
--  next_plan_version                              v           (HANYA api.py -- generate_plan)
--  save_plan                                      v           (HANYA api.py -- generate_plan)
--  import_gadm_batch                              v           (HANYA scripts/import_gadm.py, offline)
--  truncate_gadm_regions                          v           (HANYA scripts/import_gadm.py, offline)
--  import_admin_regions_batch                     v           (HANYA scripts/import_codab.py -- sudah 0007)
--  truncate_admin_regions                         v           (HANYA scripts/import_codab.py -- sudah 0007)
--  upsert_stores                                  v           (ORPHAN -- nol pemanggil aktif; dipertahankan
--                                                               service_role sbg alat admin manual)
--  preview_geocode_summary                        v           (ORPHAN -- nol pemanggil aktif)
--
-- stage_stores & commit_staging TIDAK ada di sini -- ACL-nya sudah dipasang di
-- 0008 (migrasi tempat keduanya dibuat ulang), sesuai disiplin "GRANT+REVOKE
-- hidup di migrasi yang sama dgn yang menyentuh fungsinya", bukan ditumpuk ke
-- sapuan belakangan. Tabel ini tetap menyebutnya di bagian ASERSI di bawah --
-- sapuan ini WAJIB memverifikasi seluruh 20 RPC, walau tak semua di-GRANT ulang
-- di sini.
--
-- Untuk get_stores_by_area/import_admin_regions_batch/truncate_admin_regions,
-- statement di bawah IDEMPOTEN thd yang sudah diterapkan 0005/0006/0007 --
-- REVOKE/GRANT ulang dgn kondisi sama tidak mengubah apa pun, aman dijalankan
-- lagi sbg bagian sapuan menyeluruh ini.
-- ============================================================================

-- ── Baca (browser, authenticated) ─────────────────────────────────────────────
GRANT  EXECUTE ON FUNCTION public.get_my_profile(uuid)              TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_routing_regions()             TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_routing_cabangs(uuid)         TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_routing_areas(uuid)           TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_plan_assignments(uuid)        TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_plans_by_area(uuid)           TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_plan_coverage_summary(uuid)   TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_my_profile(uuid)              FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_routing_regions()             FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_routing_cabangs(uuid)         FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_routing_areas(uuid)           FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_plan_assignments(uuid)        FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_plans_by_area(uuid)           FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_plan_coverage_summary(uuid)   FROM anon, public;

-- ── Mutasi (browser, authenticated) ───────────────────────────────────────────
-- stage_stores & commit_staging TIDAK di sini -- sudah ditangani 0008.
GRANT  EXECUTE ON FUNCTION public.approve_plan(uuid, uuid)          TO authenticated;
GRANT  EXECUTE ON FUNCTION public.discard_plan(uuid)                TO authenticated;
GRANT  EXECUTE ON FUNCTION public.discard_staging(uuid)             TO authenticated;

REVOKE EXECUTE ON FUNCTION public.approve_plan(uuid, uuid)          FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.discard_plan(uuid)                FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.discard_staging(uuid)             FROM anon, public;

-- ── Campuran (browser + api.py) -- pola 0005/0006, idempoten ─────────────────
GRANT  EXECUTE ON FUNCTION public.get_stores_by_area(uuid, uuid)    TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_stores_by_area(uuid, uuid)    FROM anon, public;

-- ── HANYA api.py (service_role) ───────────────────────────────────────────────
GRANT  EXECUTE ON FUNCTION public.next_plan_version(uuid)                              TO service_role;
GRANT  EXECUTE ON FUNCTION public.save_plan(uuid,uuid,text,jsonb,jsonb,jsonb,uuid,jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.next_plan_version(uuid)                              FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.save_plan(uuid,uuid,text,jsonb,jsonb,jsonb,uuid,jsonb) FROM anon, authenticated, public;

-- ── HANYA scripts/ offline (service_role) -- termasuk RPC GADM lama yang
--    masih ada walau sudah digantikan admin_regions/COD-AB (0007-0008) ───────
GRANT  EXECUTE ON FUNCTION public.import_gadm_batch(jsonb)          TO service_role;
GRANT  EXECUTE ON FUNCTION public.truncate_gadm_regions()           TO service_role;
GRANT  EXECUTE ON FUNCTION public.import_admin_regions_batch(jsonb) TO service_role;
GRANT  EXECUTE ON FUNCTION public.truncate_admin_regions()          TO service_role;

REVOKE EXECUTE ON FUNCTION public.import_gadm_batch(jsonb)          FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.truncate_gadm_regions()           FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.import_admin_regions_batch(jsonb) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.truncate_admin_regions()          FROM anon, authenticated, public;

-- ── Orphan -- nol pemanggil aktif hari ini ────────────────────────────────────
-- upsert_stores & preview_geocode_summary TIDAK dipanggil dari src/, api.py,
-- maupun scripts/ manapun (diverifikasi grep menyeluruh, 2026-08-05).
-- Dipertahankan utk service_role sbg alat admin manual -- BUKAN dihapus,
-- guard otorisasi upsert_stores (0003) menyiratkan ia memang dirancang dipakai
-- suatu saat. Jangan biarkan authenticated/anon menjangkau keduanya selama tak
-- ada pemanggil browser yg terverifikasi.
GRANT  EXECUTE ON FUNCTION public.upsert_stores(uuid, jsonb)        TO service_role;
GRANT  EXECUTE ON FUNCTION public.preview_geocode_summary(jsonb)    TO service_role;

REVOKE EXECUTE ON FUNCTION public.upsert_stores(uuid, jsonb)        FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.preview_geocode_summary(jsonb)    FROM anon, authenticated, public;

-- ============================================================================
-- ASERSI -- gagal keras bila SATU SAJA dari 20 RPC salah, jangan lolos senyap
-- ============================================================================
DO $$
DECLARE
  -- stage_stores & commit_staging TERMASUK di sini walau di-GRANT/REVOKE di
  -- 0008, bukan di berkas ini -- migrasi ini WAJIB memverifikasi seluruh 20
  -- RPC tanpa kecuali, supaya sapuan ini benar-benar "penutup", bukan cuma
  -- "penutup untuk yang kebetulan belum ditangani migrasi lain".
  v_browser   text[] := ARRAY[
    'get_my_profile(uuid)', 'get_routing_regions()', 'get_routing_cabangs(uuid)',
    'get_routing_areas(uuid)', 'get_plan_assignments(uuid)', 'get_plans_by_area(uuid)',
    'get_plan_coverage_summary(uuid)', 'approve_plan(uuid,uuid)', 'discard_plan(uuid)',
    'stage_stores(uuid,jsonb)', 'commit_staging(uuid)', 'discard_staging(uuid)'
  ];
  v_svc_only  text[] := ARRAY[
    'next_plan_version(uuid)',
    'save_plan(uuid,uuid,text,jsonb,jsonb,jsonb,uuid,jsonb)',
    'import_gadm_batch(jsonb)', 'truncate_gadm_regions()',
    'import_admin_regions_batch(jsonb)', 'truncate_admin_regions()',
    'upsert_stores(uuid,jsonb)', 'preview_geocode_summary(jsonb)'
  ];
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY v_browser LOOP
    IF has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon punya EXECUTE pada %  -- harus authenticated saja', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated KEHILANGAN EXECUTE pada %  -- browser akan rusak', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY v_svc_only LOOP
    IF has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon/authenticated punya EXECUTE pada %  -- harus service_role saja', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role KEHILANGAN EXECUTE pada %  -- api.py/scripts akan rusak', v_fn;
    END IF;
  END LOOP;

  -- get_stores_by_area: pola campuran, diperiksa terpisah.
  IF has_function_privilege('anon', 'public.get_stores_by_area(uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon punya EXECUTE pada get_stores_by_area -- lubang 0006 terulang';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.get_stores_by_area(uuid,uuid)'::regprocedure, 'EXECUTE')
      AND has_function_privilege('service_role',  'public.get_stores_by_area(uuid,uuid)'::regprocedure, 'EXECUTE')) THEN
    RAISE EXCEPTION 'get_stores_by_area kehilangan akses authenticated/service_role';
  END IF;
END $$;
