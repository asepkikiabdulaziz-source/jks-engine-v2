-- ✅ DITERAPKAN ke prod 2026-07-17 (dgn persetujuan pemilik + koordinasi nabati-heroes,
-- fungsi ini fisik di schema public milik mereka). Diverifikasi via HTTP+JWT sungguhan:
-- admin@jks.pma (EXTERNAL_JKS) lolos, user Heroes asli (Putri, manager_nasional) DITOLAK 42501,
-- anon key tanpa login DITOLAK di layer grant. Heroes memperbarui capture 0397 mereka sesudah ini.
--
-- Konteks: C1 (ROADMAP.md) — api.py & RPC ini hanya cek "JWT valid dari GoTrue bersama",
-- BUKAN "user berwenang di JKS". Karena DB dipakai bersama nabati-heroes (~1300 akun aktif),
-- siapa pun yang login di APLIKASI MEREKA sendiri sudah punya token yang lolos ke 5 RPC mutasi
-- JKS ini. Guard di bawah menutupnya: exec ditolak (42501) kecuali user punya slot HR AKTIF
-- dengan role_id yang terdaftar & aktif di jks_engine.access_roles.
--
-- Pola persis usulan nabati-heroes (INSTRUKSI_dari_nabati-heroes.md §7a) — fungsi ini secara
-- fisik tinggal di schema `public` (akan pindah ke `jks` nanti, lihat ROADMAP item S3), tapi
-- Heroes sudah mengundang kita mengubahnya SEKARANG ("PR murni milik kalian").
--
-- SEBELUM APPLY:
--   1. Jalankan tiap query verifikasi di bagian bawah file ini terhadap definisi LIVE
--      (fungsi bisa saja sudah berubah sejak draft ini ditulis 2026-07-17).
--   2. Uji admin@jks.pma (EXTERNAL_JKS, 000004) TETAP lolos — dan user Heroes TANPA
--      access_roles entry DITOLAK.
--   3. Terapkan lewat runner (pindah file ke migrations/ + nomor urut benar), bukan psql manual.

-- ============================================================
-- 1. get_my_profile — BUKAN plpgsql (LANGUAGE sql murni), tak bisa disisipi IF/RAISE.
--    Fix: filter pakai auth.uid(), bukan p_user_id dari klien (yang bisa dipalsukan
--    pemanggil untuk membaca profil ORANG LAIN). Parameter dipertahankan demi kompatibilitas
--    signature FE (AuthContext.tsx memanggil dgn { p_user_id: userId }), tapi NILAINYA
--    diabaikan sepenuhnya di WHERE — auth.uid() tak bisa dipalsukan pemanggil.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_profile(p_user_id uuid)
 RETURNS TABLE(nik text, full_name text, slot_code text, role_name text, role_id text, division_id text, scope_type text, scope_id text, scope_name text, branch_code text, branch_name text, region_code text, region_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'warehouse', 'mst_hr', 'mst_area', 'master', 'heroes2'
AS $function$
  SELECT
    saf.assignment_nik,
    saf.employee_name,
    saf.slot_code,
    saf.role_name,
    saf.role_id,
    saf.division_id,
    saf.scope_type,
    saf.scope_id,
    saf.scope_name,
    saf.branch_code,
    saf.branch_name,
    saf.region_code,
    saf.region_name
  FROM mst_hr.slot_assignment_flat  saf
  JOIN jks_engine.access_roles      ar  ON ar.job_title_id = saf.role_id
                                       AND ar.is_active = true
  WHERE saf.auth_user_id = auth.uid()   -- was: p_user_id (parameter klien, bisa dipalsukan)
  LIMIT 1;
$function$;

-- ============================================================
-- 2. approve_plan, discard_plan, save_plan, stage_stores, upsert_stores
--    Guard identik disisipkan tepat setelah BEGIN, sebelum logika asli (tak diubah sama
--    sekali). Fully-qualified schema names dipakai di guard (mst_hr./jks_engine.) sehingga
--    aman terlepas dari SET search_path masing-masing fungsi (tak semuanya menyertakan
--    mst_hr) -- tak perlu mengubah search_path yang sudah ada.
-- ============================================================

CREATE OR REPLACE FUNCTION public.approve_plan(p_plan_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
DECLARE
  v_area_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mst_hr.slot_assignment_flat saf
      JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
     WHERE saf.auth_user_id = auth.uid()
       AND saf.employee_is_active = true
  ) THEN
    RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
  END IF;

  -- Ambil area_id dari plan yang akan di-approve
  SELECT area_id INTO v_area_id
  FROM jks_engine.plans
  WHERE id = p_plan_id AND status = 'DRAFT';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan tidak ditemukan atau bukan DRAFT';
  END IF;

  -- Archive semua plan APPROVED sebelumnya di area yang sama
  UPDATE jks_engine.plans
  SET status     = 'ARCHIVED',
      updated_at = now()
  WHERE area_id = v_area_id
    AND status  = 'APPROVED'
    AND id     != p_plan_id;

  -- Set plan ini ke APPROVED
  UPDATE jks_engine.plans
  SET status      = 'APPROVED',
      approved_at = now(),
      approved_by = p_user_id,
      updated_at  = now()
  WHERE id = p_plan_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.discard_plan(p_plan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mst_hr.slot_assignment_flat saf
      JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
     WHERE saf.auth_user_id = auth.uid()
       AND saf.employee_is_active = true
  ) THEN
    RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
  END IF;

  -- Pastikan hanya DRAFT yang bisa dihapus
  IF NOT EXISTS (
    SELECT 1 FROM jks_engine.plans WHERE id = p_plan_id AND status = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Hanya plan berstatus DRAFT yang dapat dihapus';
  END IF;

  DELETE FROM jks_engine.plan_assignments WHERE plan_id = p_plan_id;
  DELETE FROM jks_engine.plans            WHERE id      = p_plan_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_plan(p_plan_id uuid, p_area_id uuid, p_plan_name text, p_divisions jsonb, p_version_ids jsonb, p_summary jsonb, p_created_by uuid, p_assignments jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM mst_hr.slot_assignment_flat saf
        JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
       WHERE saf.auth_user_id = auth.uid()
         AND saf.employee_is_active = true
    ) THEN
      RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
    END IF;

    INSERT INTO jks_engine.plans
        (id, area_id, plan_name, status, divisions, version_ids, summary, created_by)
    VALUES
        (p_plan_id, p_area_id, p_plan_name, 'DRAFT',
         p_divisions, p_version_ids, p_summary, p_created_by);

    INSERT INTO jks_engine.plan_assignments (
        plan_id, div_sls, customer_code, sales_person_name, philosophy,
        day_index, day_of_week, visit_cycle, visit_ganjil, visit_genap,
        visit_order, qc_flag, version_id
    )
    SELECT
        p_plan_id,
        a->>'div_sls',
        a->>'customer_code',
        a->>'sales_person_name',
        a->>'philosophy',
        (a->>'day_index')::smallint,
         a->>'day_of_week',
         a->>'visit_cycle',
        (a->>'visit_ganjil')::boolean,
        (a->>'visit_genap')::boolean,
        (a->>'visit_order')::smallint,
         a->>'qc_flag',
         a->>'version_id'
    FROM jsonb_array_elements(p_assignments) a;

    RETURN p_plan_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_stores(p_area_id uuid, p_stores jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
DECLARE
  v_session_id    uuid := gen_random_uuid();
  v_total         int;
  v_geocoded      int;
  v_summary       jsonb;
  v_not_found     jsonb;
  v_anomali       jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mst_hr.slot_assignment_flat saf
      JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
     WHERE saf.auth_user_id = auth.uid()
       AND saf.employee_is_active = true
  ) THEN
    RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
  END IF;

  v_total := jsonb_array_length(p_stores);

  -- Hapus staging lama untuk area ini
  DELETE FROM jks_engine.stores_staging WHERE area_id = p_area_id;

  -- Insert semua stores ke staging
  INSERT INTO jks_engine.stores_staging (
    staging_session_id, area_id,
    customer_code, customer_name,
    latitude, longitude,
    div_sls, type, omset, visit_frequency,
    uploaded_by
  )
  SELECT
    v_session_id, p_area_id,
    s->>'customer_code', s->>'customer_name',
    (s->>'latitude')::float8, (s->>'longitude')::float8,
    NULLIF(s->>'div_sls', ''), NULLIF(s->>'type', ''),
    CASE WHEN (s->>'omset') IS NOT NULL AND (s->>'omset') != ''
         THEN (s->>'omset')::numeric END,
    COALESCE(NULLIF(s->>'visit_frequency', '')::int, 1),
    auth.uid()
  FROM jsonb_array_elements(p_stores) s;

  -- Pass 1: exact ST_Within (memanfaatkan spatial index)
  UPDATE jks_engine.stores_staging st
  SET
    gadm_provinsi  = g.name_1,
    gadm_kota      = g.name_2,
    gadm_kecamatan = g.name_3,
    gadm_kelurahan = g.name_4,
    geocode_ok     = true
  FROM jks_engine.gadm_regions g
  WHERE st.staging_session_id = v_session_id
    AND ST_Within(
          ST_SetSRID(ST_MakePoint(st.longitude, st.latitude), 4326),
          g.geom
        );

  -- Pass 2: KNN fallback untuk titik di celah simplifikasi polygon (<=0.01deg ~ 1km)
  WITH to_geocode AS (
    SELECT id, longitude, latitude
    FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id
      AND NOT geocode_ok
  )
  UPDATE jks_engine.stores_staging st
  SET
    gadm_provinsi  = g.name_1,
    gadm_kota      = g.name_2,
    gadm_kecamatan = g.name_3,
    gadm_kelurahan = g.name_4,
    geocode_ok     = true
  FROM to_geocode tg
  CROSS JOIN LATERAL (
    SELECT name_1, name_2, name_3, name_4
    FROM jks_engine.gadm_regions
    WHERE geom && ST_Expand(
            ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326),
            0.01
          )
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326)
    LIMIT 1
  ) g
  WHERE st.id = tg.id;

  SELECT COUNT(*) INTO v_geocoded
  FROM jks_engine.stores_staging
  WHERE staging_session_id = v_session_id AND geocode_ok = true;

  -- Ringkasan distribusi per kecamatan
  SELECT jsonb_agg(row ORDER BY jumlah DESC)
  INTO v_summary
  FROM (
    SELECT
      gadm_provinsi  AS name_1,
      gadm_kota      AS name_2,
      gadm_kecamatan AS name_3,
      COUNT(*)::int  AS jumlah,
      ROUND(COUNT(*) * 100.0 / NULLIF(v_geocoded, 0), 1)::numeric(5,1) AS pct
    FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id AND geocode_ok = true
    GROUP BY gadm_provinsi, gadm_kota, gadm_kecamatan
  ) row;

  -- Toko yang tidak ter-geocode (di luar wilayah GADM)
  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', customer_code,
    'customer_name', customer_name,
    'lat', latitude,
    'lon', longitude
  ))
  INTO v_not_found
  FROM jks_engine.stores_staging
  WHERE staging_session_id = v_session_id AND geocode_ok = false;

  -- Toko mencurigakan: ter-geocode tapi masuk kecamatan dengan total <= 2 toko
  -- (kemungkinan koordinat meleset). Field kecamatan/kota dibuat identik dengan
  -- summary (name_3 / name_2) agar bisa di-join langsung di frontend.
  WITH kec_cnt AS (
    SELECT gadm_provinsi, gadm_kota, gadm_kecamatan, COUNT(*) AS cnt
    FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id AND geocode_ok = true
    GROUP BY gadm_provinsi, gadm_kota, gadm_kecamatan
  )
  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', s.customer_code,
    'customer_name', s.customer_name,
    'lat',           s.latitude,
    'lon',           s.longitude,
    'kecamatan',     s.gadm_kecamatan,
    'kota',          s.gadm_kota
  ))
  INTO v_anomali
  FROM jks_engine.stores_staging s
  JOIN kec_cnt k
    ON k.gadm_provinsi  IS NOT DISTINCT FROM s.gadm_provinsi
   AND k.gadm_kota      IS NOT DISTINCT FROM s.gadm_kota
   AND k.gadm_kecamatan IS NOT DISTINCT FROM s.gadm_kecamatan
  WHERE s.staging_session_id = v_session_id
    AND s.geocode_ok = true
    AND k.cnt <= 2;

  RETURN jsonb_build_object(
    'staging_session_id', v_session_id,
    'total',              v_total,
    'geocoded',           v_geocoded,
    'not_found',          COALESCE(v_not_found, '[]'::jsonb),
    'summary',            COALESCE(v_summary, '[]'::jsonb),
    'anomali_stores',     COALESCE(v_anomali, '[]'::jsonb)
  );
END;
$function$;

-- upsert_stores SUDAH punya guard (baris "IF v_user_id IS NULL") tapi itu cuma cek
-- "sudah login?", BUKAN "berwenang di JKS?" — sama lemahnya dgn C1. Diganti dgn guard
-- keanggotaan penuh; v_user_id tetap dipakai apa adanya di bawah (uploaded_by).
CREATE OR REPLACE FUNCTION public.upsert_stores(p_area_id uuid, p_stores jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine', 'mst_area'
AS $function$
DECLARE
  v_inserted  int := 0;
  v_updated   int := 0;
  v_errors    jsonb := '[]'::jsonb;
  v_row       jsonb;
  v_user_id   uuid;
  v_i         int := 0;
BEGIN
  v_user_id := auth.uid();

  -- was: IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated' END IF;
  -- (cuma cek login, bukan keanggotaan JKS — sama lemahnya dgn C1)
  IF NOT EXISTS (
    SELECT 1 FROM mst_hr.slot_assignment_flat saf
      JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
     WHERE saf.auth_user_id = v_user_id
       AND saf.employee_is_active = true
  ) THEN
    RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
  END IF;

  -- Validasi area_id ada
  IF NOT EXISTS (SELECT 1 FROM mst_area.areas WHERE id = p_area_id) THEN
    RAISE EXCEPTION 'area_id % not found', p_area_id;
  END IF;

  -- Loop tiap toko dalam array
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_stores) LOOP
    v_i := v_i + 1;
    BEGIN
      INSERT INTO jks_engine.stores (
        area_id, customer_code, customer_name,
        latitude, longitude,
        div_sls, type, omset,
        visit_frequency, uploaded_by
      ) VALUES (
        p_area_id,
        v_row->>'customer_code',
        v_row->>'customer_name',
        (v_row->>'latitude')::numeric,
        (v_row->>'longitude')::numeric,
        v_row->>'div_sls',
        v_row->>'type',
        CASE WHEN v_row->>'omset' IS NOT NULL THEN (v_row->>'omset')::bigint ELSE NULL END,
        COALESCE(v_row->>'visit_frequency', 'BIWEEKLY'),
        v_user_id
      )
      ON CONFLICT (area_id, customer_code) DO UPDATE SET
        customer_name   = EXCLUDED.customer_name,
        latitude        = EXCLUDED.latitude,
        longitude       = EXCLUDED.longitude,
        div_sls         = EXCLUDED.div_sls,
        type            = EXCLUDED.type,
        omset           = EXCLUDED.omset,
        visit_frequency = EXCLUDED.visit_frequency,
        uploaded_by     = EXCLUDED.uploaded_by,
        updated_at      = now();

      IF found THEN
        v_inserted := v_inserted + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object(
        'row', v_i,
        'customer_code', v_row->>'customer_code',
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'upserted', v_inserted,
    'errors',   v_errors,
    'total',    v_i
  );
END;
$function$;

-- ============================================================
-- VERIFIKASI (jalankan setelah apply, sebelum anggap selesai)
-- ============================================================
-- 1. admin@jks.pma (EXTERNAL_JKS) TETAP bisa (perlu SET ROLE / uji via curl+JWT asli,
--    tak bisa disimulasikan penuh lewat SQL biasa karena auth.uid() bergantung sesi JWT):
--      set request.jwt.claims to '{"sub":"6ac912c3-7f87-4bcf-81f3-a1fe4e02b7c1"}';
--      select approve_plan('<plan_id_draft_apa_saja>'::uuid, '6ac912c3-...'::uuid);
--      -- harus TIDAK melempar 'Akses ditolak'
--
-- 2. User Heroes TANPA slot HR aktif (mis. UUID acak) DITOLAK:
--      set request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000000000"}';
--      select approve_plan('<any>'::uuid, '00000000-...'::uuid);
--      -- HARUS melempar 'Akses ditolak: user tidak berwenang di JKS' (42501)
--
-- 3. get_my_profile masih balikin profil benar utk admin@jks.pma via anon+JWT asli (curl),
--    BUKAN via psql (auth.uid() NULL di sesi psql biasa -> akan selalu 0 baris di sana).
