-- 0009_fix_visit_frequency.sql
-- Perbaiki frekuensi kunjungan: normalkan DATA, bukan tambal pembacanya.
--
-- ⚠️ Menimpa stage_stores & upsert_stores DI ATAS versi 0008. Terapkan berurutan.
--
-- ============================================================================
-- BUG YANG DIPERBAIKI
-- ============================================================================
-- jks_engine.stores.visit_frequency = text, dan SELURUH 22.674 baris berisi '1'.
-- Pemilik data mengonfirmasi (2026-08-05): '1' berarti MINGGUAN.
--
-- Tapi _store_visit_freq (api.py) hanya mencocokkan string "WEEKLY":
--     if raw_val and str(raw_val).upper() == "WEEKLY": return WEEKLY
--     return BIWEEKLY                      <-- '1' selalu jatuh ke sini
--
-- Akibatnya BUKAN sekadar input yang menganggur -- ia keluaran yang aktif salah.
-- core/biweekly.py:41-48 menangani WEEKLY dengan benar (ganjil=genap=True, artinya
-- dikunjungi TIAP pekan), tapi tak pernah menerimanya. Jadi setiap toko dibelah ke
-- pekan ganjil/genap:
--
--     plan            : 2 APPROVED, 22 DRAFT
--     cycle           : M2 pada 25 dari 25 division-run
--     assignments     : 20.537 selang-pekan, 0 tiap-pekan
--     beban/sales/hari: tercatat ~38 toko, seharusnya ~76
--
-- Terverifikasi bahwa dampaknya TERBATAS pada flag ganjil/genap -- penempatan
-- (sales, hari) tidak berubah sama sekali. Itu sebabnya penundaannya dulu sah,
-- dan itu juga sebabnya perbaikan ini tidak membatalkan kerja partisi teritori.
--
-- ============================================================================
-- KENAPA MEMPERBAIKI DATA, BUKAN PEMBACANYA
-- ============================================================================
-- Ada EMPAT jalur tulis dengan DUA sistem tipe yang berbeda:
--   stores_staging.visit_frequency = integer, default 1
--   stores.visit_frequency         = text,    default 'BIWEEKLY'
--   stage_stores  (0003:228) : COALESCE(...::int, 1)          -> menulis ANGKA
--   upsert_stores (0003:395) : COALESCE(..., 'BIWEEKLY')      -> menulis TEKS
--
-- Menambal pembacanya berarti mengajari api.py memahami '1', lalu mengajari
-- RoutingEnginePage.tsx:497 hal yang sama, lalu setiap pembaca berikutnya.
-- Menormalkan datanya menyelesaikannya sekali: begitu DB berisi 'WEEKLY',
-- api.py DAN frontend yang sudah membandingkan dengan 'WEEKLY' langsung benar
-- tanpa perlu diubah.
--
-- CATATAN: bug yang sama ADA DI FRONTEND -- RoutingEnginePage.tsx:497
--   const weekly = (s.visit_frequency ?? '').toUpperCase() === 'WEEKLY'
-- Badge "Pola pekan berbeda dari visit_frequency toko" selama ini SELALU
-- menghitung weekly=false. Migrasi ini memperbaikinya tanpa menyentuh FE.
--
-- ============================================================================
-- NOTASI: kenapa TIDAK memakai 4/4 - 2/4 - 1/4 sebagai nilai DB
-- ============================================================================
-- Industri distribusi Indonesia memakai notasi call cycle:
--     4/4 = mingguan  |  2/4 = dua-mingguan  |  1/4 = bulanan
-- Itu bahasa PEMBELI dan wajib dipakai di UI/percakapan. Tapi sebagai nilai
-- tersimpan ia menambah satu lapis terjemahan di setiap pembaca -- persis
-- masalah yang sedang diperbaiki. Nilai DB dibuat sama dengan enum engine
-- (VisitFrequency), notasi call cycle jadi LABEL TAMPILAN.
--
-- Alasan kedua yang mengikat: engine._version_id() mem-hash
-- s.visit_frequency.value. Mengubah nilai enum akan mengubah SELURUH version_id
-- yang pernah dibuat.

-- ============================================================================
-- 1. NORMALKAN DATA YANG ADA
-- ============================================================================
DO $$
DECLARE v_lain int;
BEGIN
  -- Fail-loud: kalau ada nilai selain '1', pemetaannya belum diketahui dan
  -- menebaknya persis kesalahan yang sedang diperbaiki.
  SELECT count(*) INTO v_lain FROM jks_engine.stores
   WHERE visit_frequency IS NOT NULL
     AND visit_frequency NOT IN ('1', 'WEEKLY', 'BIWEEKLY', 'MONTHLY');
  IF v_lain > 0 THEN
    RAISE EXCEPTION
      '% baris punya visit_frequency di luar pemetaan yang dikonfirmasi '
      '(1=MINGGUAN). Tanyakan artinya ke pemilik data -- jangan ditebak.', v_lain;
  END IF;
END $$;

UPDATE jks_engine.stores SET visit_frequency = 'WEEKLY'  WHERE visit_frequency = '1';
UPDATE jks_engine.stores SET visit_frequency = 'BIWEEKLY' WHERE visit_frequency IS NULL;

-- ============================================================================
-- 2. KUNCI SKEMA -- nilai non-kanonik tak bisa masuk lagi
-- ============================================================================
ALTER TABLE jks_engine.stores ALTER COLUMN visit_frequency SET DEFAULT 'BIWEEKLY';
ALTER TABLE jks_engine.stores ALTER COLUMN visit_frequency SET NOT NULL;

ALTER TABLE jks_engine.stores DROP CONSTRAINT IF EXISTS stores_visit_frequency_check;
ALTER TABLE jks_engine.stores ADD CONSTRAINT stores_visit_frequency_check
  CHECK (visit_frequency IN ('WEEKLY', 'BIWEEKLY'));

COMMENT ON COLUMN jks_engine.stores.visit_frequency IS
  'WEEKLY | BIWEEKLY. Notasi industri utk TAMPILAN: 4/4 | 2/4. '
  'MONTHLY (1/4) DIKENALI tapi DITOLAK -- engine belum bisa merepresentasikannya. '
  'Nilai harus kanonik -- sampai 0009 kolom ini berisi kode tenant (''1'') yang '
  'tak dikenali pembaca mana pun, dan seluruh toko dijadwalkan separuh frekuensi.';

-- stores_staging: integer -> text, supaya kedua jalur tulis memakai satu bahasa.
-- Tabel transien (dihapus per sesi), jadi konversi ini tak berisiko data.
DELETE FROM jks_engine.stores_staging;
ALTER TABLE jks_engine.stores_staging
  ALTER COLUMN visit_frequency DROP DEFAULT;
ALTER TABLE jks_engine.stores_staging
  ALTER COLUMN visit_frequency TYPE text USING
    CASE visit_frequency WHEN 1 THEN 'WEEKLY' WHEN 2 THEN 'BIWEEKLY' ELSE 'BIWEEKLY' END;
ALTER TABLE jks_engine.stores_staging
  ALTER COLUMN visit_frequency SET DEFAULT 'BIWEEKLY';

ALTER TABLE jks_engine.stores_staging DROP CONSTRAINT IF EXISTS stores_staging_visit_frequency_check;
ALTER TABLE jks_engine.stores_staging ADD CONSTRAINT stores_staging_visit_frequency_check
  CHECK (visit_frequency IS NULL OR visit_frequency IN ('WEEKLY', 'BIWEEKLY'));

-- ============================================================================
-- 3. NORMALISASI DI GERBANG MASUK
-- ============================================================================
-- Menerima ejaan yang wajar (termasuk istilah Indonesia), menolak yang tak
-- dikenali. Default DIIZINKAN tapi harus TERHITUNG -- lihat stage_stores.
CREATE OR REPLACE FUNCTION jks_engine.norm_visit_frequency(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE v text;
BEGIN
  v := upper(btrim(coalesce(p_raw, '')));
  IF v = '' THEN RETURN NULL; END IF;   -- pemanggil yang memutuskan default

  -- ANGKA TELANJANG SENGAJA TIDAK DITERIMA. Lihat catatan di bawah -- '1'
  -- berarti MINGGUAN di pengkodean Nabati tapi BULANAN dalam notasi call cycle
  -- (1/4). Angka yang sama, arti berlawanan. Hanya bentuk tak-ambigu diterima.
  RETURN CASE
    WHEN v IN ('WEEKLY','MINGGUAN','W','4/4')                   THEN 'WEEKLY'
    WHEN v IN ('BIWEEKLY','DUA MINGGUAN','2 MINGGUAN','B','2/4') THEN 'BIWEEKLY'
    WHEN v IN ('MONTHLY','BULANAN','M','1/4')                   THEN 'MONTHLY'
    ELSE NULL
  END;
END;
$function$;

COMMENT ON FUNCTION jks_engine.norm_visit_frequency(text) IS
  'Normalkan frekuensi ke nilai kanonik. NULL = tak dikenali ATAU kosong; '
  'pemanggil WAJIB membedakan keduanya dan tidak boleh diam-diam mendefault.';

-- ⚠️ KENAPA ANGKA TELANJANG DITOLAK
-- '1' berarti MINGGUAN di pengkodean Nabati (dikonfirmasi pemilik 2026-08-05).
-- Tapi dalam notasi call cycle industri, 1/4 berarti BULANAN. Angka yang sama,
-- arti BERLAWANAN. Memetakan '1' secara global berarti memilih satu tenant dan
-- diam-diam salah untuk tenant berikutnya -- persis kelas kesalahan yang sedang
-- diperbaiki migrasi ini.
--
-- Data '1' yang ADA ditangani UPDATE satu kali di bagian 1. Unggahan BARU yang
-- mengirim angka telanjang akan DITOLAK dengan pesan jelas, bukan ditebak.
-- Aman hari ini: UploadTokoPage.tsx belum mengirim visit_frequency sama sekali
-- (nol rujukan), jadi tak ada pengunggah yang saat ini mengirim '1'.
--
-- Kalau kelak ada tenant dengan pengkodean angka sendiri, pemetaannya jadi
-- KONFIGURASI PER-TENANT -- bukan ditambahkan ke daftar ini.

-- ============================================================================
-- 4. stage_stores -- versi 0008 + frekuensi kanonik + hitungan default
-- ============================================================================
-- Guard C1 (0003) dan geocoding admin_regions (0008) direproduksi persis.
-- Asersi di akhir berkas menangkap kalau salah satunya hilang.
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
  v_freq_default  int;
  v_freq_tolak    jsonb;
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

  -- Frekuensi yang DIISI tapi TIDAK DIKENALI = tolak seluruh unggahan.
  -- Membiarkannya jatuh ke default persis cara bug ini lahir.
  SELECT jsonb_agg(DISTINCT s->>'visit_frequency')
  INTO v_freq_tolak
  FROM jsonb_array_elements(p_stores) s
  WHERE COALESCE(btrim(s->>'visit_frequency'), '') <> ''
    AND jks_engine.norm_visit_frequency(s->>'visit_frequency') IS NULL;

  IF v_freq_tolak IS NOT NULL THEN
    RAISE EXCEPTION
      'visit_frequency tidak dikenali: %. Pakai WEEKLY/BIWEEKLY (atau 4/4, 2/4).',
      v_freq_tolak;
  END IF;

  -- MONTHLY dikenali TAPI ditolak dengan alasan yang jelas. Engine memodelkan
  -- cadence biner (M1 = tiap pekan, M2 = ganjil/genap); bulanan butuh perombakan
  -- cadence yang VISI §2 sebut sebagai sumbu MAHAL. Menolak di gerbang jauh lebih
  -- baik daripada menerima lalu gagal saat plan dibuat.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stores) s
    WHERE jks_engine.norm_visit_frequency(s->>'visit_frequency') = 'MONTHLY'
  ) THEN
    RAISE EXCEPTION
      'Frekuensi BULANAN (call cycle 1/4) belum didukung -- engine memodelkan '
      'cadence biner (mingguan / dua-mingguan). Butuh perombakan cadence.';
  END IF;

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
    -- Default BIWEEKLY diizinkan, TAPI dihitung & dilaporkan (v_freq_default).
    COALESCE(jks_engine.norm_visit_frequency(s->>'visit_frequency'), 'BIWEEKLY'),
    auth.uid()
  FROM jsonb_array_elements(p_stores) s;

  SELECT count(*) INTO v_freq_default
  FROM jsonb_array_elements(p_stores) s
  WHERE COALESCE(btrim(s->>'visit_frequency'), '') = '';

  -- Pass 1: exact ST_Within (admin_regions / COD-AB, lihat 0008)
  UPDATE jks_engine.stores_staging st
  SET gadm_provinsi = a.adm1_name, gadm_kota = a.adm2_name,
      gadm_kecamatan = a.adm3_name, gadm_kelurahan = a.adm4_name,
      adm3_pcode = a.adm3_pcode, adm4_pcode = a.adm4_pcode,
      geocode_ok = true
  FROM jks_engine.admin_regions a
  WHERE st.staging_session_id = v_session_id
    AND ST_Within(ST_SetSRID(ST_MakePoint(st.longitude, st.latitude), 4326), a.geom);

  -- Pass 2: KNN fallback <=0.01deg (~1 km)
  WITH to_geocode AS (
    SELECT id, longitude, latitude FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id AND NOT geocode_ok
  )
  UPDATE jks_engine.stores_staging st
  SET gadm_provinsi = a.adm1_name, gadm_kota = a.adm2_name,
      gadm_kecamatan = a.adm3_name, gadm_kelurahan = a.adm4_name,
      adm3_pcode = a.adm3_pcode, adm4_pcode = a.adm4_pcode,
      geocode_ok = true
  FROM to_geocode tg
  CROSS JOIN LATERAL (
    SELECT adm1_name, adm2_name, adm3_name, adm4_name, adm3_pcode, adm4_pcode
    FROM jks_engine.admin_regions
    WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326), 0.01)
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(tg.longitude, tg.latitude), 4326)
    LIMIT 1
  ) a
  WHERE st.id = tg.id;

  SELECT COUNT(*) INTO v_geocoded
  FROM jks_engine.stores_staging
  WHERE staging_session_id = v_session_id AND geocode_ok = true;

  SELECT jsonb_agg(row ORDER BY jumlah DESC)
  INTO v_summary
  FROM (
    SELECT gadm_provinsi AS name_1, gadm_kota AS name_2, gadm_kecamatan AS name_3,
           COUNT(*)::int AS jumlah,
           ROUND(COUNT(*) * 100.0 / NULLIF(v_geocoded, 0), 1)::numeric(5,1) AS pct
    FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id AND geocode_ok = true
    GROUP BY adm3_pcode, gadm_provinsi, gadm_kota, gadm_kecamatan
  ) row;

  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', customer_code, 'customer_name', customer_name,
    'lat', latitude, 'lon', longitude))
  INTO v_not_found
  FROM jks_engine.stores_staging
  WHERE staging_session_id = v_session_id AND geocode_ok = false;

  WITH kec_cnt AS (
    SELECT adm3_pcode, COUNT(*) AS cnt FROM jks_engine.stores_staging
    WHERE staging_session_id = v_session_id AND geocode_ok = true
    GROUP BY adm3_pcode
  )
  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', s.customer_code, 'customer_name', s.customer_name,
    'lat', s.latitude, 'lon', s.longitude,
    'kecamatan', s.gadm_kecamatan, 'kota', s.gadm_kota))
  INTO v_anomali
  FROM jks_engine.stores_staging s
  JOIN kec_cnt k ON k.adm3_pcode IS NOT DISTINCT FROM s.adm3_pcode
  WHERE s.staging_session_id = v_session_id AND s.geocode_ok = true AND k.cnt <= 2;

  RETURN jsonb_build_object(
    'staging_session_id',  v_session_id,
    'total',               v_total,
    'geocoded',            v_geocoded,
    -- BARU: default tak lagi tak terlihat. Frontend WAJIB menampilkan angka ini.
    'frequency_defaulted', v_freq_default,
    'not_found',           COALESCE(v_not_found, '[]'::jsonb),
    'summary',             COALESCE(v_summary, '[]'::jsonb),
    'anomali_stores',      COALESCE(v_anomali, '[]'::jsonb)
  );
END;
$function$;

-- ============================================================================
-- 5. upsert_stores -- hentikan default senyap ke 'BIWEEKLY'
-- ============================================================================
-- Hanya baris frekuensi yang berubah dari versi 0003; sisanya dipertahankan.
CREATE OR REPLACE FUNCTION public.upsert_stores(p_area_id uuid, p_stores jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_row     jsonb;
  v_count   int := 0;
  v_freq    text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mst_hr.slot_assignment_flat saf
      JOIN jks_engine.access_roles ar ON ar.job_title_id = saf.role_id AND ar.is_active
     WHERE saf.auth_user_id = COALESCE(auth.uid(), v_user_id)
       AND saf.employee_is_active = true
  ) THEN
    RAISE EXCEPTION 'Akses ditolak: user tidak berwenang di JKS' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM mst_area.areas WHERE id = p_area_id) THEN
    RAISE EXCEPTION 'area_id % not found', p_area_id;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_stores) LOOP
    IF COALESCE(btrim(v_row->>'visit_frequency'), '') <> '' THEN
      v_freq := jks_engine.norm_visit_frequency(v_row->>'visit_frequency');
      IF v_freq IS NULL THEN
        RAISE EXCEPTION 'visit_frequency tidak dikenali: % (toko %)',
          v_row->>'visit_frequency', v_row->>'customer_code';
      END IF;
      IF v_freq = 'MONTHLY' THEN
        RAISE EXCEPTION 'Frekuensi BULANAN belum didukung engine (toko %)',
          v_row->>'customer_code';
      END IF;
    ELSE
      v_freq := 'BIWEEKLY';
    END IF;

    INSERT INTO jks_engine.stores (
      area_id, customer_code, customer_name, latitude, longitude,
      div_sls, type, omset, visit_frequency, uploaded_by
    ) VALUES (
      p_area_id, v_row->>'customer_code', v_row->>'customer_name',
      (v_row->>'latitude')::float8, (v_row->>'longitude')::float8,
      NULLIF(v_row->>'div_sls',''), NULLIF(v_row->>'type',''),
      CASE WHEN COALESCE(v_row->>'omset','') <> '' THEN (v_row->>'omset')::numeric END,
      v_freq, v_user_id
    )
    ON CONFLICT (area_id, customer_code) DO UPDATE SET
      customer_name   = EXCLUDED.customer_name,
      latitude        = EXCLUDED.latitude,
      longitude       = EXCLUDED.longitude,
      div_sls         = EXCLUDED.div_sls,
      type            = EXCLUDED.type,
      omset           = EXCLUDED.omset,
      visit_frequency = EXCLUDED.visit_frequency,
      is_active       = true,
      updated_at      = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('upserted', v_count);
END;
$function$;

-- ============================================================================
-- 5b. ACL -- upsert_stores TAK PERNAH dapat grant eksplisit sejak 0001
-- ============================================================================
-- Sama seperti stage_stores/commit_staging di 0008: 0001 cuma dump definisi,
-- bukan ACL, dan tak ada migrasi manapun sebelum ini yang menuliskan grant utk
-- upsert_stores. Direplay ke DB kosong, ia lahir EXECUTE-TO-ANON lewat default
-- privileges Supabase. upsert_stores ORPHAN (nol pemanggil terverifikasi di
-- src/, api.py, scripts/ -- lihat 0010_harden_all_rpc_acl.sql), jadi diberi
-- service_role saja, BUKAN authenticated -- kalau kelak dipakai browser,
-- tambahkan grant authenticated eksplisit saat itu, jangan biarkan terbuka
-- duluan "buat jaga-jaga".
GRANT  EXECUTE ON FUNCTION public.upsert_stores(uuid, jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.upsert_stores(uuid, jsonb) FROM anon, authenticated, public;

-- ============================================================================
-- 6. ASERSI
-- ============================================================================
DO $$
DECLARE v_weekly int; v_lain int;
BEGIN
  SELECT count(*) FILTER (WHERE visit_frequency = 'WEEKLY'),
         count(*) FILTER (WHERE visit_frequency <> 'WEEKLY')
    INTO v_weekly, v_lain
  FROM jks_engine.stores;
  RAISE NOTICE 'stores: % WEEKLY, % lainnya', v_weekly, v_lain;

  IF EXISTS (SELECT 1 FROM jks_engine.stores WHERE visit_frequency = '1') THEN
    RAISE EXCEPTION 'Masih ada visit_frequency = ''1'' -- normalisasi gagal';
  END IF;

  -- Guard C1 & geocoding COD-AB tidak boleh hilang karena penulisan ulang ini.
  IF position('Akses ditolak' IN pg_get_functiondef(
       'public.stage_stores(uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'stage_stores kehilangan guard C1 -- REGRESI KEAMANAN';
  END IF;
  IF position('admin_regions' IN pg_get_functiondef(
       'public.stage_stores(uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'stage_stores kembali memakai gadm_regions -- cutover 0008 batal';
  END IF;

  IF has_function_privilege('anon', 'public.stage_stores(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.upsert_stores(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon punya EXECUTE pada RPC mutasi -- lubang 0006 terulang';
  END IF;
END $$;

-- ============================================================================
-- SESUDAH MIGRASI INI
-- ============================================================================
-- 1. api.py: _store_visit_freq harus GAGAL KERAS untuk nilai tak dikenal, bukan
--    diam-diam mengembalikan BIWEEKLY. Default senyap itulah yang membuat bug ini
--    hidup di produksi tanpa terdeteksi.
-- 2. Frontend: tampilkan `frequency_defaulted` dari respons stage_stores.
-- 3. 20.537 assignment pada plan LAMA tetap salah -- migrasi ini tidak menyentuh
--    plan yang sudah tersimpan. Dua plan APPROVED perlu KEPUTUSAN OPERASIONAL:
--    dibuat ulang, atau dibiarkan sampai siklus berikutnya. Bukan soal kode.
-- 4. Label tampilan yang dipakai pembeli: 4/4 (mingguan), 2/4 (dua-mingguan),
--    1/4 (bulanan).
