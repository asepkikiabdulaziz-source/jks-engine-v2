-- 0008_cutover_admin_regions.sql
-- Pindahkan jalur geocoding produksi dari GADM ke COD-AB (tabel admin_regions, 0007).
--
-- ⚠️ JANGAN jalankan sebelum `python scripts/import_codab.py` selesai.
--    Migrasi ini menolak jalan kalau admin_regions kosong (lihat PRA-SYARAT).
--
-- ============================================================================
-- BUKTI YANG MENDASARI CUTOVER INI (verifikasi offline, 2026-08-05)
-- ============================================================================
-- 22.674 toko produksi diuji point-in-polygon terhadap KEDUA sumber, lalu
-- dibandingkan SECARA GEOMETRIS (IoU poligon kecamatan), bukan secara teks --
-- karena stores.gadm_kecamatan adalah nilai TURUNAN yang ditulis GADM sendiri,
-- jadi membandingkan teks = membandingkan ejaan GADM vs ejaan COD-AB, dan tak
-- satu pun dari keduanya kebenaran.
--
--   poligon SAMA (IoU >= 0.60) : 22.424  (98,91%)
--   poligon BEDA               :    248  ( 1,09%)
--     - 174 = Batujajar -> pemekaran Saguling. COD-AB LEBIH BENAR, GADM usang.
--     -  74 = beda batas nyata di pinggir kecamatan  -> beda_geometris.csv
--
--   CAKUPAN: GADM gagal 1 toko, COD-AB gagal 2 TANPA fallback. Yang kedua
--   berjarak 527 m dari poligon terdekat -> tertangkap KNN fallback 1 km yang
--   memang sudah ada di Pass 2. Dengan fallback yang sama, keduanya gagal pada
--   toko yang SAMA: C2140895, 17,8 km di tengah laut (Selat Bali) -- itu cacat
--   koordinat di data toko, bukan cacat peta.
--
-- Perbandingan TEKSTUAL menyesatkan di DUA arah, dan itu sebabnya tidak dipakai:
--   - 'Jatiuwung' vs 'Jati Uwung'  -> dihitung beda, padahal poligon identik
--   - 'Pakisaji'  vs 'Pakis Aji'   -> dihitung sama, padahal IoU 0,09 =
--     DUA KECAMATAN BERBEDA (Malang vs Jepara). Normalisasi ejaan justru
--     MENYEMBUNYIKAN yang ini.
--
-- ============================================================================
-- PELAJARAN YANG DIKODEKAN DI SINI: SIMPAN KODE, BUKAN NAMA
-- ============================================================================
-- Seluruh kebisingan di atas lahir dari satu sebab -- sistem menyimpan NAMA
-- wilayah. COD-AB memberi adm3_pcode/adm4_pcode = kode BPS berawalan "ID".
-- Dengan menyimpan KODE dan memperlakukan nama sebagai tampilan:
--   * beda ejaan berhenti jadi masalah, selamanya
--   * jebakan Pakisaji/Pakis Aji mustahil terjadi -- kodenya berbeda
--   * join ke statistik BPS (Podes: jumlah warung per desa) langsung jalan
--   * pergantian sumber peta berikutnya tak memicu latihan seperti hari ini
--
-- ============================================================================
-- PRA-SYARAT -- gagal keras, jangan setengah jalan
-- ============================================================================
DO $$
DECLARE v_n bigint;
BEGIN
  IF to_regclass('jks_engine.admin_regions') IS NULL THEN
    RAISE EXCEPTION 'jks_engine.admin_regions belum ada -- terapkan 0007 dulu';
  END IF;
  SELECT count(*) INTO v_n FROM jks_engine.admin_regions;
  IF v_n < 70000 THEN
    RAISE EXCEPTION
      'admin_regions baru berisi % baris (COD-AB ADM4 = 81.912). Jalankan '
      'scripts/import_codab.py sampai selesai sebelum cutover.', v_n;
  END IF;
  RAISE NOTICE 'Pra-syarat OK: % poligon di admin_regions', v_n;
END $$;

-- ============================================================================
-- 1. KOLOM KODE
-- ============================================================================
-- Kolom gadm_* SENGAJA tidak diganti nama. Mengganti berarti mengubah signature
-- get_stores_by_area + 3 call-site api.py + tampilan FE -- churn besar untuk
-- migrasi yang tugasnya menukar sumber data. Namanya kini keliru secara harfiah,
-- jadi diberi COMMENT agar tak menyesatkan pembaca berikutnya.
ALTER TABLE jks_engine.stores
  ADD COLUMN IF NOT EXISTS adm3_pcode text,
  ADD COLUMN IF NOT EXISTS adm4_pcode text;

ALTER TABLE jks_engine.stores_staging
  ADD COLUMN IF NOT EXISTS adm3_pcode text,
  ADD COLUMN IF NOT EXISTS adm4_pcode text;

CREATE INDEX IF NOT EXISTS stores_adm3_pcode_idx ON jks_engine.stores (adm3_pcode);

COMMENT ON COLUMN jks_engine.stores.adm3_pcode IS
  'Kode BPS kecamatan berawalan ID (COD-AB). INI kunci yang sah -- bukan nama.';
COMMENT ON COLUMN jks_engine.stores.gadm_kecamatan IS
  'Nama kecamatan untuk TAMPILAN. Nama kolom historis (dulu diisi GADM); sejak '
  '0008 diisi dari admin_regions/COD-AB. Jangan dipakai sebagai kunci join -- '
  'pakai adm3_pcode.';

-- ============================================================================
-- 2. stage_stores -- geocode ke admin_regions
-- ============================================================================
-- ⚠️ Guard otorisasi dari 0003 DIREPRODUKSI PERSIS di bawah. CREATE OR REPLACE
--    menimpa seluruh badan fungsi: kalau guard ini lupa disalin, migrasi
--    "penggantian peta" akan diam-diam MENCABUT perbaikan keamanan C1.
--    Ada asersi di akhir berkas yang menggagalkan migrasi bila itu terjadi.
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

  DELETE FROM jks_engine.stores_staging WHERE area_id = p_area_id;

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

  -- Pass 1: exact ST_Within (memanfaatkan GIST index)
  UPDATE jks_engine.stores_staging st
  SET
    gadm_provinsi  = a.adm1_name,
    gadm_kota      = a.adm2_name,
    gadm_kecamatan = a.adm3_name,
    gadm_kelurahan = a.adm4_name,
    adm3_pcode     = a.adm3_pcode,
    adm4_pcode     = a.adm4_pcode,
    geocode_ok     = true
  FROM jks_engine.admin_regions a
  WHERE st.staging_session_id = v_session_id
    AND ST_Within(
          ST_SetSRID(ST_MakePoint(st.longitude, st.latitude), 4326),
          a.geom
        );

  -- Pass 2: KNN fallback <=0.01deg (~1 km) untuk titik di celah simplifikasi.
  -- Verifikasi membuktikan pass ini yang menyelamatkan toko pesisir 527 m.
  WITH to_geocode AS (
    SELECT id, longitude, latitude
    FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id
      AND NOT geocode_ok
  )
  UPDATE jks_engine.stores_staging st
  SET
    gadm_provinsi  = a.adm1_name,
    gadm_kota      = a.adm2_name,
    gadm_kecamatan = a.adm3_name,
    gadm_kelurahan = a.adm4_name,
    adm3_pcode     = a.adm3_pcode,
    adm4_pcode     = a.adm4_pcode,
    geocode_ok     = true
  FROM to_geocode tg
  CROSS JOIN LATERAL (
    SELECT adm1_name, adm2_name, adm3_name, adm4_name, adm3_pcode, adm4_pcode
    FROM jks_engine.admin_regions
    WHERE geom && ST_Expand(
            ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326),
            0.01
          )
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326)
    LIMIT 1
  ) a
  WHERE st.id = tg.id;

  SELECT COUNT(*) INTO v_geocoded
  FROM jks_engine.stores_staging
  WHERE staging_session_id = v_session_id AND geocode_ok = true;

  -- Ringkasan per kecamatan. Dikelompokkan per PCODE (kunci sah), nama ikut
  -- untuk tampilan -- ini menutup jebakan Pakisaji/Pakis Aji di panel ringkasan.
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
    GROUP BY adm3_pcode, gadm_provinsi, gadm_kota, gadm_kecamatan
  ) row;

  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', customer_code,
    'customer_name', customer_name,
    'lat', latitude,
    'lon', longitude
  ))
  INTO v_not_found
  FROM jks_engine.stores_staging
  WHERE staging_session_id = v_session_id AND geocode_ok = false;

  -- Toko mencurigakan: masuk kecamatan yang total tokonya <= 2. Dihitung per
  -- PCODE, bukan per nama -- dua kecamatan sehomonim tak lagi tergabung palsu.
  WITH kec_cnt AS (
    SELECT adm3_pcode, COUNT(*) AS cnt
    FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id AND geocode_ok = true
    GROUP BY adm3_pcode
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
  JOIN kec_cnt k ON k.adm3_pcode IS NOT DISTINCT FROM s.adm3_pcode
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

-- ============================================================================
-- 3. commit_staging -- bawa pcode ikut ke stores
-- ============================================================================
CREATE OR REPLACE FUNCTION public.commit_staging(p_staging_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
DECLARE
  v_upserted int;
  v_total    int;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM jks_engine.stores_staging
  WHERE staging_session_id = p_staging_session_id;

  IF v_total = 0 THEN
    RETURN jsonb_build_object('upserted', 0, 'total', 0, 'empty', true);
  END IF;

  INSERT INTO jks_engine.stores (
    area_id, customer_code, customer_name,
    latitude, longitude,
    div_sls, type, omset, visit_frequency,
    gadm_provinsi, gadm_kota, gadm_kecamatan, gadm_kelurahan,
    adm3_pcode, adm4_pcode,
    is_active, uploaded_by
  )
  SELECT
    area_id, customer_code, customer_name,
    latitude, longitude,
    div_sls, type, omset, visit_frequency,
    gadm_provinsi, gadm_kota, gadm_kecamatan, gadm_kelurahan,
    adm3_pcode, adm4_pcode,
    true, uploaded_by
  FROM jks_engine.stores_staging
  WHERE staging_session_id = p_staging_session_id
  ON CONFLICT (area_id, customer_code) DO UPDATE SET
    customer_name   = EXCLUDED.customer_name,
    latitude        = EXCLUDED.latitude,
    longitude       = EXCLUDED.longitude,
    div_sls         = EXCLUDED.div_sls,
    type            = EXCLUDED.type,
    omset           = EXCLUDED.omset,
    visit_frequency = EXCLUDED.visit_frequency,
    gadm_provinsi   = EXCLUDED.gadm_provinsi,
    gadm_kota       = EXCLUDED.gadm_kota,
    gadm_kecamatan  = EXCLUDED.gadm_kecamatan,
    gadm_kelurahan  = EXCLUDED.gadm_kelurahan,
    adm3_pcode      = EXCLUDED.adm3_pcode,
    adm4_pcode      = EXCLUDED.adm4_pcode,
    is_active       = true,
    uploaded_by     = EXCLUDED.uploaded_by,
    updated_at      = now();

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  DELETE FROM jks_engine.stores_staging
  WHERE staging_session_id = p_staging_session_id;

  RETURN jsonb_build_object('upserted', v_upserted, 'total', v_total);
END;
$function$;

-- ============================================================================
-- 4. preview_geocode_summary -- panel anomali FE
-- ============================================================================
-- Kalau ini dilewatkan, panel anomali menilai unggahan memakai peta LAMA
-- sementara data disimpan memakai peta BARU. Ketidakcocokan senyap.
CREATE OR REPLACE FUNCTION public.preview_geocode_summary(p_points jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
  WITH pts AS (
    SELECT
      pt->>'customer_code' AS customer_code,
      ST_SetSRID(ST_MakePoint(
        (pt->>'lon')::float,
        (pt->>'lat')::float
      ), 4326) AS pt_geom
    FROM jsonb_array_elements(p_points) pt
  ),
  exact AS (
    SELECT p.customer_code, a.adm1_name, a.adm2_name, a.adm3_name, a.adm4_name
    FROM pts p
    JOIN jks_engine.admin_regions a ON ST_Within(p.pt_geom, a.geom)
  ),
  fallback AS (
    SELECT p.customer_code, a.adm1_name, a.adm2_name, a.adm3_name, a.adm4_name
    FROM pts p
    CROSS JOIN LATERAL (
      SELECT adm1_name, adm2_name, adm3_name, adm4_name
      FROM jks_engine.admin_regions
      WHERE geom && ST_Expand(p.pt_geom, 0.01)
      ORDER BY geom <-> p.pt_geom
      LIMIT 1
    ) a
    WHERE p.customer_code NOT IN (SELECT customer_code FROM exact)
  ),
  combined AS (
    SELECT customer_code, adm1_name, adm2_name, adm3_name, adm4_name FROM exact
    UNION ALL
    SELECT customer_code, adm1_name, adm2_name, adm3_name, adm4_name FROM fallback
  )
  SELECT jsonb_build_object(
    'geocoded',  (SELECT COUNT(*) FROM combined),
    'total',     (SELECT COUNT(*) FROM pts),
    'summary',   COALESCE((
      SELECT jsonb_agg(r ORDER BY r->>'jumlah' DESC)
      FROM (
        SELECT jsonb_build_object(
          'name_1', adm1_name, 'name_2', adm2_name, 'name_3', adm3_name,
          'jumlah', COUNT(*)::int
        ) AS r
        FROM combined
        GROUP BY adm1_name, adm2_name, adm3_name
      ) s
    ), '[]'::jsonb),
    'not_found', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('customer_code', customer_code))
      FROM pts WHERE customer_code NOT IN (SELECT customer_code FROM combined)
    ), '[]'::jsonb)
  );
$function$;

-- ============================================================================
-- 4b. ACL -- pelajaran 0006 diterapkan DI TEMPAT fungsinya dibuat ulang
-- ============================================================================
-- CREATE OR REPLACE tidak mengubah ACL fungsi yang SUDAH ADA -- tapi ketiganya
-- di atas TIDAK ADA satu pun migrasi kita sendiri yang PERNAH menuliskan grant
-- eksplisit untuknya (0001 cuma dump definisi, bukan ACL). Di prod mereka
-- terlihat aman HANYA karena menumpang sapuan keamanan project lain (lihat
-- 0010_harden_all_rpc_acl.sql utk detail lengkap temuan ini). Direplay ke DB
-- kosong tanpa baris ini, stage_stores/commit_staging/preview_geocode_summary
-- lahir EXECUTE-TO-ANON lewat default privileges Supabase.
--
-- preview_geocode_summary: nol pemanggil terverifikasi (src/, api.py, scripts/)
-- -- diperlakukan sbg orphan, service_role saja, BUKAN authenticated. Kalau
-- kelak dipakai browser, tambahkan grant authenticated eksplisit saat itu.
GRANT  EXECUTE ON FUNCTION public.stage_stores(uuid, jsonb)      TO authenticated;
GRANT  EXECUTE ON FUNCTION public.commit_staging(uuid)           TO authenticated;
GRANT  EXECUTE ON FUNCTION public.preview_geocode_summary(jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.stage_stores(uuid, jsonb)      FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.commit_staging(uuid)           FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.preview_geocode_summary(jsonb) FROM anon, authenticated, public;

-- ============================================================================
-- 5. BACKFILL 22.674 toko yang sudah ada
-- ============================================================================
-- Pola Pass 1 + Pass 2 yang sama. Hasil yang diharapkan (dari verifikasi):
-- ~450 baris berubah nama kecamatan, 248 di antaranya benar-benar pindah
-- poligon (174 = koreksi pemekaran Saguling), 1 toko tetap gagal (di laut).
DO $$
DECLARE
  v_pass1 int; v_pass2 int; v_sisa int; v_pindah int;
BEGIN
  SELECT COUNT(*) INTO v_pindah
  FROM jks_engine.stores s
  JOIN jks_engine.admin_regions a
    ON ST_Within(ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326), a.geom)
  WHERE s.is_active AND s.gadm_kecamatan IS DISTINCT FROM a.adm3_name;

  UPDATE jks_engine.stores s
  SET gadm_provinsi = a.adm1_name, gadm_kota = a.adm2_name,
      gadm_kecamatan = a.adm3_name, gadm_kelurahan = a.adm4_name,
      adm3_pcode = a.adm3_pcode, adm4_pcode = a.adm4_pcode
  FROM jks_engine.admin_regions a
  WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    AND ST_Within(ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326), a.geom);
  GET DIAGNOSTICS v_pass1 = ROW_COUNT;

  -- ⚠️ UPDATE ... FROM LATERAL (...) TIDAK BISA mereferensikan alias TARGET
  -- update (di sini "s") langsung di dalam subquery LATERAL -- itu bukan
  -- "preceding from_item" yang sah bagi LATERAL, beda dari SELECT biasa.
  -- Postgres menolak dgn "invalid reference to FROM-clause entry for table s"
  -- (diverifikasi langsung, Docker lokal, 2026-08-05). stage_stores (Pass 2)
  -- TIDAK kena bug ini karena sudah lebih dulu memakai pola CTE+alias yang
  -- benar (to_geocode tg) -- pola yang sama dipakai ulang di sini.
  WITH to_geocode AS (
    SELECT id, longitude, latitude
    FROM jks_engine.stores
    WHERE adm3_pcode IS NULL
      AND latitude IS NOT NULL AND longitude IS NOT NULL
  )
  UPDATE jks_engine.stores s
  SET gadm_provinsi = a.adm1_name, gadm_kota = a.adm2_name,
      gadm_kecamatan = a.adm3_name, gadm_kelurahan = a.adm4_name,
      adm3_pcode = a.adm3_pcode, adm4_pcode = a.adm4_pcode
  FROM to_geocode tg
  CROSS JOIN LATERAL (
    SELECT adm1_name, adm2_name, adm3_name, adm4_name, adm3_pcode, adm4_pcode
    FROM jks_engine.admin_regions
    WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326), 0.01)
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326)
    LIMIT 1
  ) a
  WHERE s.id = tg.id;
  GET DIAGNOSTICS v_pass2 = ROW_COUNT;

  SELECT COUNT(*) INTO v_sisa
  FROM jks_engine.stores
  WHERE adm3_pcode IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;

  RAISE NOTICE 'Backfill: pass1=% pass2=% gagal=% (pindah kecamatan: %)',
    v_pass1, v_pass2, v_sisa, v_pindah;

  -- 1 kegagalan = toko di Selat Bali (koordinat salah, sudah dikenali).
  -- Lebih dari itu berarti ada yang tak beres dengan impor poligonnya.
  IF v_sisa > 5 THEN
    RAISE EXCEPTION
      '% toko gagal dapat poligon (diharapkan <=1: C2140895 di laut). '
      'Impor admin_regions kemungkinan tidak lengkap -- migrasi dibatalkan.', v_sisa;
  END IF;
END $$;

-- ============================================================================
-- 6. ASERSI -- guard & ACL tidak boleh regresi karena migrasi ini
-- ============================================================================
DO $$
BEGIN
  -- Guard C1 harus MASIH ada di stage_stores (CREATE OR REPLACE menimpa badan
  -- fungsi -- ini yang menangkap kalau guardnya lupa disalin).
  IF position('Akses ditolak' IN pg_get_functiondef(
       'public.stage_stores(uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'stage_stores kehilangan guard otorisasi C1 -- REGRESI KEAMANAN';
  END IF;

  -- ACL: signature tidak berubah, jadi CREATE OR REPLACE mempertahankan grant.
  -- Diperiksa toh -- pelajaran 0006: jangan pernah mengasumsikan ACL.
  IF has_function_privilege('anon', 'public.stage_stores(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.commit_staging(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon punya EXECUTE pada RPC mutasi -- lubang 0006 terulang';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.stage_stores(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated kehilangan EXECUTE pada stage_stores -- Upload Toko mati';
  END IF;
END $$;

-- ============================================================================
-- YANG SENGAJA TIDAK DILAKUKAN
-- ============================================================================
-- * gadm_regions TIDAK di-drop. Ia jalur rollback: kalau ada yang tak beres,
--   0008 tinggal dibalik tanpa impor ulang 82.000 poligon. Drop menyusul,
--   sebagai migrasi tersendiri, setelah beberapa siklus unggah berjalan tenang.
-- * gadm_kecamatan & gadm_provinsi TIDAK disentuh -- keduanya dibuat migrasi
--   0280/0281 nabati-heroes DI DALAM schema kita dan dibaca fitur peta DWM
--   mereka. Memindahkannya bagian dari pemisahan DB, harus dikoordinasikan.
-- * Kolom stores.gadm_* TIDAK diganti nama (churn ke RPC + api.py + FE).
--   Sudah diberi COMMENT bahwa namanya historis.
-- * get_stores_by_area BELUM mengembalikan pcode. Ditambahkan saat lapis
--   Potensi butuh join ke BPS -- bukan sekarang, supaya cutover ini tetap
--   satu perubahan yang bisa dibaca sekali duduk.
