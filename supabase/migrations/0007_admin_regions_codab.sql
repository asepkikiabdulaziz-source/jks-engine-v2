-- 0007_admin_regions_codab.sql
-- Tabel batas wilayah baru dari COD-AB, menggantikan GADM.
--
-- ============================================================================
-- KENAPA PINDAH DARI GADM
-- ============================================================================
-- Lisensi GADM (https://gadm.org/license.html, dicek 2026-08-05, verbatim):
--   "The data are freely available for academic use and other non-commercial
--    use. Redistribution or commercial use is not allowed without prior
--    permission."
--
-- Selama JKS alat internal, statusnya abu-abu. Begitu ia jadi alat yang dipakai
-- pihak lain untuk keperluan bisnis, ia jelas komersial. GADM tak menerbitkan
-- harga lisensi komersial -- hanya formulir kontak.
--
-- PENGGANTI: COD-AB (Common Operational Datasets - Administrative Boundaries).
--   sumber      : Badan Pusat Statistik (BPS - Statistics Indonesia)
--   dikurasi    : OCHA Regional Office for Asia and the Pacific
--   diterbitkan : OCHA Field Information Services + HDX
--   lisensi     : CC BY 3.0 IGO -- komersial BOLEH, kewajiban HANYA atribusi,
--                 TIDAK ada share-alike (turunan boleh tertutup)
--   dataset     : https://data.humdata.org/dataset/cod-ab-idn
--   verifikasi  : HDX CKAN API package_show -> license_id "cc-by-igo"
--
-- Ini bukan pemetaan asing -- ini data resmi BPS yang distandarkan & diberi
-- lisensi terbuka oleh badan PBB.
--
-- LEBIH LENGKAP, bukan sekadar lebih bebas:
--   kecamatan (ADM3) : COD-AB  7.069  vs GADM 6.695   (BPS mencatat ~7.281)
--   desa      (ADM4) : COD-AB 81.912  vs GADM 77.473
-- Kekurangan kecamatan di GADM bikin "Kecamatan X: 0 toko" bisa jadi artefak
-- poligon hilang, bukan temuan whitespace. Itu penting untuk lapis Potensi.
--
-- BONUS -- ini alasan teknis, bukan cuma legal: adm4_pcode = "ID" + KODE BPS.
--   ID1671060006 -> 16 Sumsel / 1671 Kota Palembang / 1671060 kec / ...0006 desa
-- Artinya statistik BPS lain (mis. Podes yang mencacah toko/warung kelontong
-- per desa) bisa di-JOIN LEWAT KODE, bukan pencocokan nama yang rapuh. GADM
-- memakai skema GID buatannya sendiri -- join itu tak pernah bisa bersih.
--
-- ⚠️ YANG DIKORBANKAN: vintage. Batas COD-AB dibuat 8 April 2020 (tanggal
-- "30 Oktober 2025" di HDX adalah PENINJAUAN, bukan pembaruan). ADM1 = 34
-- provinsi -> SEBELUM pemekaran Papua 2022. Lapisan provinsi paling jarang
-- dipakai JKS; kecamatan & desa justru lebih lengkap. BIG (Ina-Geoportal) punya
-- edisi 2022 tapi jenis lisensinya belum dinyatakan -- ditanyakan terpisah.
--
-- ============================================================================
-- KENAPA TABEL BARU, BUKAN MENIMPA gadm_regions
-- ============================================================================
-- 1. BISA DIBANDINGKAN DULU. Re-geocode 22.674 toko terhadap tabel baru, diff
--    terhadap kolom gadm_* yang sekarang -> lihat apa yang berubah SEBELUM
--    memindahkan jalur produksi. Menimpa langsung menghapus pembandingnya.
-- 2. Rollback = tidak melakukan apa-apa.
-- 3. Nama netral-sumber. "gadm_regions" mematri vendor ke dalam skema, dan
--    itulah yang membuat pergantian ini terasa mahal. Jangan diulang.
--
-- Tabel ini TIDAK menyentuh gadm_regions / gadm_kecamatan / gadm_provinsi.
-- Aman diterapkan ke DB bersama sekarang MAUPUN di-replay ke DB baru nanti.
-- Cutover (mengarahkan stage_stores ke sini) = migrasi TERPISAH, setelah
-- verifikasi di bawah lulus.

-- ============================================================================
-- TABEL
-- ============================================================================
CREATE TABLE IF NOT EXISTS jks_engine.admin_regions (
  id            bigserial PRIMARY KEY,

  -- Hierarki COD-AB. Nama kolom sengaja mengikuti sumber (adm1..adm4), bukan
  -- name_1..name_4 gaya GADM -- supaya asalnya jelas saat dibaca orang lain.
  adm1_name     text NOT NULL,   -- provinsi        (-> stores.gadm_provinsi)
  adm2_name     text NOT NULL,   -- kota/kabupaten  (-> stores.gadm_kota)
  adm3_name     text NOT NULL,   -- kecamatan       (-> stores.gadm_kecamatan)
  adm4_name     text NOT NULL,   -- desa/kelurahan  (-> stores.gadm_kelurahan)

  -- P-code = "ID" + kode BPS. INI kunci join ke statistik BPS (Podes dll).
  adm0_pcode    text NOT NULL,
  adm1_pcode    text NOT NULL,
  adm2_pcode    text NOT NULL,
  adm3_pcode    text NOT NULL,
  adm4_pcode    text NOT NULL,

  -- Ikut disalin dari sumber -- gratis, dan berguna utk lapis Potensi
  -- (kepadatan = jumlah toko / area_sqkm; centroid utk label peta).
  area_sqkm     double precision,
  center_lat    double precision,
  center_lon    double precision,

  geom          geometry(MultiPolygon, 4326) NOT NULL,

  -- PROVENANS. CC BY-IGO mewajibkan atribusi; menyimpannya di baris data
  -- membuat kewajiban itu tak bisa hilang karena lupa. Sekaligus menjawab
  -- "data ini dari mana, versi berapa" tanpa menebak.
  source          text NOT NULL DEFAULT 'COD-AB (OCHA/HDX), source: BPS Indonesia',
  source_license  text NOT NULL DEFAULT 'CC BY 3.0 IGO',
  source_url      text NOT NULL DEFAULT 'https://data.humdata.org/dataset/cod-ab-idn',
  source_version  text,           -- mis. "v01"
  valid_on        date,           -- mis. 2020-04-01
  imported_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE jks_engine.admin_regions IS
  'Batas administrasi Indonesia (desa/kelurahan) dari COD-AB, CC BY 3.0 IGO. '
  'Sumber: BPS via OCHA/HDX. Atribusi WAJIB ditampilkan di UI/dokumentasi. '
  'Pengganti gadm_regions (GADM: non-komersial).';

COMMENT ON COLUMN jks_engine.admin_regions.adm4_pcode IS
  'P-code = "ID" + kode BPS. Kunci join ke statistik BPS (Podes, sensus).';

-- Index: pola sama dgn gadm_regions + satu tambahan utk join BPS per kecamatan.
CREATE UNIQUE INDEX IF NOT EXISTS admin_regions_adm4_pcode_idx
  ON jks_engine.admin_regions (adm4_pcode);
CREATE INDEX IF NOT EXISTS admin_regions_geom_idx
  ON jks_engine.admin_regions USING gist (geom);
CREATE INDEX IF NOT EXISTS admin_regions_adm3_pcode_idx
  ON jks_engine.admin_regions (adm3_pcode);
CREATE INDEX IF NOT EXISTS admin_regions_adm1_name_idx
  ON jks_engine.admin_regions (adm1_name);
CREATE INDEX IF NOT EXISTS admin_regions_adm2_name_idx
  ON jks_engine.admin_regions (adm2_name);

ALTER TABLE jks_engine.admin_regions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated can select admin_regions" ON jks_engine.admin_regions;
CREATE POLICY "authenticated can select admin_regions"
  ON jks_engine.admin_regions FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- RPC IMPOR (dipakai scripts/import_codab.py)
-- ============================================================================
-- Skema jks_engine tak diekspos PostgREST, jadi impor lewat RPC SECURITY
-- DEFINER -- pola sama dgn truncate_gadm_regions / import_gadm_batch.

CREATE OR REPLACE FUNCTION public.truncate_admin_regions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
  TRUNCATE jks_engine.admin_regions RESTART IDENTITY;
END;
$function$;

CREATE OR REPLACE FUNCTION public.import_admin_regions_batch(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'jks_engine', 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO jks_engine.admin_regions (
    adm1_name, adm2_name, adm3_name, adm4_name,
    adm0_pcode, adm1_pcode, adm2_pcode, adm3_pcode, adm4_pcode,
    area_sqkm, center_lat, center_lon,
    source_version, valid_on, geom
  )
  SELECT
    r->>'adm1_name', r->>'adm2_name', r->>'adm3_name', r->>'adm4_name',
    r->>'adm0_pcode', r->>'adm1_pcode', r->>'adm2_pcode',
    r->>'adm3_pcode', r->>'adm4_pcode',
    NULLIF(r->>'area_sqkm','')::double precision,
    NULLIF(r->>'center_lat','')::double precision,
    NULLIF(r->>'center_lon','')::double precision,
    NULLIF(r->>'source_version',''),
    NULLIF(r->>'valid_on','')::date,
    ST_Multi(ST_SetSRID(ST_GeomFromText(r->>'wkt'), 4326))
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (adm4_pcode) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ============================================================================
-- ACL -- PELAJARAN MIGRASI 0006, DITERAPKAN DI DEPAN
-- ============================================================================
-- CREATE FUNCTION di schema public otomatis dapat EXECUTE TO PUBLIC (default
-- Postgres) DAN TO anon/authenticated/service_role (ALTER DEFAULT PRIVILEGES
-- milik Supabase). Dua fungsi di atas adalah MUTASI -- anon tak boleh
-- menyentuhnya sama sekali. Kalau ini lupa, kita mengulang persis lubang yang
-- ditutup 0006, di migrasi yang menambah fungsi baru.
--
-- GRANT dulu, REVOKE kemudian. Impor dijalankan skrip via service_role saja;
-- `authenticated` TIDAK butuh keduanya.
GRANT  EXECUTE ON FUNCTION public.truncate_admin_regions()             TO service_role;
GRANT  EXECUTE ON FUNCTION public.import_admin_regions_batch(jsonb)    TO service_role;
REVOKE EXECUTE ON FUNCTION public.truncate_admin_regions()             FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.import_admin_regions_batch(jsonb)    FROM anon, authenticated, public;

-- Verifikasi ACL di transaksi yang sama -- gagal keras, jangan lolos senyap.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.truncate_admin_regions()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.import_admin_regions_batch(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon punya EXECUTE pada RPC impor -- lubang 0006 terulang';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.import_admin_regions_batch(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role kehilangan EXECUTE -- importer tak akan jalan';
  END IF;
END $$;

-- ============================================================================
-- LANGKAH BERIKUTNYA (bukan bagian migrasi ini)
-- ============================================================================
-- 1. Impor   : python scripts/import_codab.py <path>/idn_admin4.shp
--
-- 2. VERIFIKASI SEBELUM CUTOVER -- ini alasan tabel ini berdiri sendiri.
--    Bandingkan hasil geocoding lama vs baru untuk toko yang sudah ada:
--
--      SELECT s.gadm_kecamatan AS lama, a.adm3_name AS baru, count(*)
--      FROM jks_engine.stores s
--      JOIN jks_engine.admin_regions a
--        ON ST_Within(ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326), a.geom)
--      WHERE s.is_active
--      GROUP BY 1, 2
--      HAVING s.gadm_kecamatan IS DISTINCT FROM a.adm3_name
--      ORDER BY 3 DESC;
--
--    Cek juga toko yang GAGAL dapat poligon di tabel baru (harus <= jumlah yang
--    gagal di GADM; kalau lebih banyak, JANGAN cutover):
--
--      SELECT count(*) FROM jks_engine.stores s
--      WHERE s.is_active AND NOT EXISTS (
--        SELECT 1 FROM jks_engine.admin_regions a
--        WHERE ST_Within(ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326), a.geom));
--
-- 3. Cutover : migrasi terpisah (0008) yang mengarahkan stage_stores ke
--    admin_regions (Pass 1 ST_Within + Pass 2 KNN fallback, pola sama), lalu
--    DROP gadm_regions setelah tenang.
--    ⚠️ gadm_kecamatan & gadm_provinsi BUKAN milik kita -- dibuat migrasi
--    0280/0281 nabati-heroes di dalam schema kita. Jangan di-drop sepihak;
--    itu bagian dari pemisahan DB yang harus dikoordinasikan.
--
-- 4. ATRIBUSI: tampilkan di UI/dokumentasi, mis.
--    "Batas wilayah: COD-AB (OCHA/HDX), sumber BPS Indonesia -- CC BY 3.0 IGO"
--    Ini kewajiban lisensi, bukan basa-basi.
