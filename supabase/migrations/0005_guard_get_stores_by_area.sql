-- 0005_guard_get_stores_by_area.sql
-- Tutup C1 jalur BACA (lihat docs/ROADMAP.md §Lintas-isu, docs/incident-2026-07-17/).
--
-- get_stores_by_area dipanggil CAMPURAN: 4 tempat di src/ (browser+sesi user --
-- auth.uid() terisi wajar) DAN 3 tempat di api.py (service_role -- auth.uid() NULL,
-- persis kelas masalah yang menyebabkan regresi save_plan di 0003/0004).
--
-- Tanpa guard, JWT valid APA PUN dari GoTrue bersama (termasuk ~1300 akun
-- nabati-heroes) bisa curl /stage1, /stage2, /generate-plan dan membaca
-- customer_code + lat/lon toko AREA MANA PUN.
--
-- Fix: tambah p_caller_id uuid DEFAULT NULL. Guard pakai COALESCE(auth.uid(),
-- p_caller_id) -- pola identik save_plan (0004). DEFAULT NULL berarti 4 pemanggil
-- browser di src/ TIDAK PERLU diubah -- PostgREST kirim named-param, yang tak
-- dikirim otomatis pakai default, dan auth.uid() mereka sudah terisi benar.
-- Hanya api.py yang perlu update (3 call site: tambah "p_caller_id": user_id,
-- user_id sudah ada dari Depends(_verify_jwt) di ketiga endpoint).
--
-- Diuji test-first (tests/test_rpc_authz.py): 4 test ditulis SEBELUM migrasi
-- ini ada, dikonfirmasi 3 di antaranya GAGAL thd kode lama (celah nyata &
-- terdeteksi otomatis, bukan cuma teori).

-- CREATE OR REPLACE tak mengganti fungsi lama kalau jumlah parameter beda --
-- ia menambah OVERLOAD baru, membuat pemanggilan 1-argumen jadi AMBIGU
-- (dikonfirmasi saat validasi migrasi ini). Drop versi lama dulu.
DROP FUNCTION IF EXISTS public.get_stores_by_area(uuid);

CREATE OR REPLACE FUNCTION public.get_stores_by_area(p_area_id uuid, p_caller_id uuid DEFAULT NULL)
 RETURNS TABLE(customer_code text, customer_name text, longitude double precision, latitude double precision, div_sls text, visit_frequency text, omset double precision, gadm_kecamatan text, gadm_kelurahan text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mst_hr.slot_assignment_flat saf
      JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
     WHERE saf.auth_user_id = COALESCE(auth.uid(), p_caller_id)
       AND saf.employee_is_active = true
  ) THEN
    RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    s.customer_code::text,
    s.customer_name::text,
    s.longitude::float8,
    s.latitude::float8,
    s.div_sls::text,
    s.visit_frequency::text,
    s.omset::float8,
    s.gadm_kecamatan::text,
    s.gadm_kelurahan::text
  FROM jks_engine.stores s
  WHERE s.area_id = p_area_id
    AND s.longitude IS NOT NULL
    AND s.latitude  IS NOT NULL
    AND s.is_active = true;
END;
$function$;

-- ============================================================================
-- VERIFIKASI
-- ============================================================================
--   python -m pytest tests/test_rpc_authz.py -v -k get_stores_by_area  -> 4 lulus
--
--   Manual (HTTP, persis pola api.py):
--   curl .../rpc/get_stores_by_area -H "Authorization: Bearer $SERVICE_KEY" \
--     -d '{"p_area_id":"57b8e747-...","p_caller_id":"6ac912c3-..."}' -> lolos, data toko
--   curl .../rpc/get_stores_by_area -H "Authorization: Bearer $SERVICE_KEY" \
--     -d '{"p_area_id":"57b8e747-...","p_caller_id":"<uuid acak>"}' -> 42501
