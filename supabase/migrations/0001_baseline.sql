-- 0001_baseline.sql — snapshot skema jks_engine + RPC JKS dari DB live.
-- Dibangkitkan otomatis via scripts/dump_baseline.py (pg_dump tidak tersedia di mesin dev).
-- Ini SNAPSHOT titik-waktu, bukan migrasi inkremental — jangan re-run ke DB yang sudah punya objeknya
-- tanpa DROP dulu. Tujuan: project bisa direkonstruksi dari git, bukan operasional harian.
--
-- ⚠️ CLEAN-ROOM REPLAY: access_roles.job_title_id FK ke mst_hr.positions(id) (schema Heroes).
-- Di DB kosong/shadow, replay ini GAGAL kecuali mst_hr.positions sudah ada — sama seperti
-- masalah yang Heroes selesaikan dgn shim 0169_jks_engine_shim_for_replay.sql utk jks_engine.
-- Belum ada shim serupa dari sisi kita untuk dependency ini.

create schema if not exists jks_engine;

-- ============================================================
-- TABEL jks_engine
-- ============================================================

-- --- access_roles ---
create table if not exists jks_engine.access_roles (
  job_title_id text not null,
  label text not null,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  notes text
);
alter table jks_engine.access_roles add constraint access_roles_job_title_id_fkey FOREIGN KEY (job_title_id) REFERENCES mst_hr.positions(id) ON UPDATE CASCADE;
alter table jks_engine.access_roles add constraint access_roles_pkey PRIMARY KEY (job_title_id);


-- --- gadm_kecamatan ---
create table if not exists jks_engine.gadm_kecamatan (
  gid_3 text not null,
  name_1 text,
  name_2 text,
  name_3 text,
  geom geometry
);
alter table jks_engine.gadm_kecamatan add constraint gadm_kecamatan_pkey PRIMARY KEY (gid_3);


-- --- gadm_provinsi ---
create table if not exists jks_engine.gadm_provinsi (
  name_1 text not null,
  geom geometry
);
alter table jks_engine.gadm_provinsi add constraint gadm_provinsi_pkey PRIMARY KEY (name_1);


-- --- gadm_regions ---
create table if not exists jks_engine.gadm_regions (
  id integer not null default nextval('jks_engine.gadm_regions_id_seq'::regclass),
  name_1 text not null,
  name_2 text not null,
  name_3 text not null,
  name_4 text not null,
  geom geometry not null,
  gid_0 text,
  gid_1 text,
  gid_2 text,
  gid_3 text,
  gid_4 text,
  type_4 text
);
alter table jks_engine.gadm_regions add constraint gadm_regions_pkey PRIMARY KEY (id);
CREATE INDEX idx_gadm_regions_geom ON jks_engine.gadm_regions USING gist (geom);
CREATE UNIQUE INDEX idx_gadm_regions_gid4 ON jks_engine.gadm_regions USING btree (gid_4);
CREATE INDEX gadm_regions_geom_idx ON jks_engine.gadm_regions USING gist (geom);
CREATE INDEX gadm_regions_name1_idx ON jks_engine.gadm_regions USING btree (name_1);
CREATE INDEX gadm_regions_name2_idx ON jks_engine.gadm_regions USING btree (name_2);
create policy "authenticated can select gadm" on jks_engine.gadm_regions for select to authenticated using (true);
alter table jks_engine.gadm_regions enable row level security;


-- --- plan_assignments ---
create table if not exists jks_engine.plan_assignments (
  id uuid not null default gen_random_uuid(),
  plan_id uuid not null,
  div_sls text not null,
  customer_code text not null,
  sales_person_name text not null,
  philosophy text not null,
  day_index smallint not null,
  day_of_week text not null,
  visit_cycle text not null,
  visit_ganjil boolean not null,
  visit_genap boolean not null,
  visit_order smallint not null,
  qc_flag text,
  version_id text not null
);
alter table jks_engine.plan_assignments add constraint plan_assignments_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES jks_engine.plans(id) ON DELETE CASCADE;
alter table jks_engine.plan_assignments add constraint plan_assignments_pkey PRIMARY KEY (id);
CREATE INDEX jks_pa_plan_idx ON jks_engine.plan_assignments USING btree (plan_id);
CREATE INDEX jks_pa_div_idx ON jks_engine.plan_assignments USING btree (plan_id, div_sls);
CREATE UNIQUE INDEX jks_pa_uniq ON jks_engine.plan_assignments USING btree (plan_id, customer_code);


-- --- plans ---
create table if not exists jks_engine.plans (
  id uuid not null default gen_random_uuid(),
  area_id uuid not null,
  plan_name text not null,
  status text not null default 'DRAFT'::text,
  divisions jsonb not null default '[]'::jsonb,
  version_ids jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  approved_at timestamp with time zone,
  approved_by uuid,
  store_count integer default 0
);
alter table jks_engine.plans add constraint plans_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'APPROVED'::text, 'ARCHIVED'::text])));
alter table jks_engine.plans add constraint plans_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);
alter table jks_engine.plans add constraint plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table jks_engine.plans add constraint plans_pkey PRIMARY KEY (id);
CREATE INDEX jks_plans_area_idx ON jks_engine.plans USING btree (area_id, created_at DESC);
CREATE INDEX idx_plans_area_status ON jks_engine.plans USING btree (area_id, status, created_at DESC);


-- --- stores ---
create table if not exists jks_engine.stores (
  id uuid not null default gen_random_uuid(),
  area_id uuid not null,
  customer_code text not null,
  customer_name text not null,
  latitude numeric(10,7) not null,
  longitude numeric(10,7) not null,
  div_sls text,
  type text,
  omset bigint,
  visit_frequency text not null default 'BIWEEKLY'::text,
  gadm_region text,
  is_active boolean not null default true,
  uploaded_by uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  gadm_provinsi text,
  gadm_kota text,
  gadm_kecamatan text,
  gadm_kelurahan text
);
alter table jks_engine.stores add constraint stores_area_id_fkey FOREIGN KEY (area_id) REFERENCES mst_area.areas(id);
alter table jks_engine.stores add constraint stores_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id);
alter table jks_engine.stores add constraint stores_pkey PRIMARY KEY (id);
alter table jks_engine.stores add constraint stores_area_id_customer_code_key UNIQUE (area_id, customer_code);
create policy "authenticated can select stores" on jks_engine.stores for select to authenticated using (true);
alter table jks_engine.stores enable row level security;


-- --- stores_staging ---
create table if not exists jks_engine.stores_staging (
  id uuid not null default gen_random_uuid(),
  staging_session_id uuid not null,
  area_id uuid not null,
  customer_code text not null,
  customer_name text not null,
  latitude double precision not null,
  longitude double precision not null,
  div_sls text,
  type text,
  omset numeric,
  visit_frequency integer default 1,
  gadm_provinsi text,
  gadm_kota text,
  gadm_kecamatan text,
  gadm_kelurahan text,
  geocode_ok boolean default false,
  uploaded_by uuid,
  created_at timestamp with time zone default now()
);
alter table jks_engine.stores_staging add constraint stores_staging_pkey PRIMARY KEY (id);
CREATE INDEX idx_stores_staging_session ON jks_engine.stores_staging USING btree (staging_session_id);
CREATE INDEX idx_stores_staging_area ON jks_engine.stores_staging USING btree (area_id);


-- ============================================================
-- FUNGSI jks_engine
-- ============================================================

-- --- set_updated_at ---
CREATE OR REPLACE FUNCTION jks_engine.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;


-- ============================================================
-- RPC JKS (fisik masih di public — akan pindah ke schema `jks`, lihat ROADMAP)
-- ============================================================

-- --- public.get_my_profile ---
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
  WHERE saf.auth_user_id = p_user_id
  LIMIT 1;
$function$
;


-- --- public.get_routing_regions ---
CREATE OR REPLACE FUNCTION public.get_routing_regions()
 RETURNS TABLE(id uuid, kd_region text, nama_region text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'mst_area', 'public'
AS $function$
  SELECT r.id, r.kd_region, r.nama_region
  FROM mst_area.regions r
  ORDER BY r.kd_region;
$function$
;


-- --- public.get_routing_cabangs ---
CREATE OR REPLACE FUNCTION public.get_routing_cabangs(p_region_id uuid)
 RETURNS TABLE(id uuid, kd_cabang text, nama_cabang text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'mst_area', 'public'
AS $function$
  SELECT c.id, c.kd_cabang, c.nama_cabang
  FROM mst_area.cabangs c
  WHERE c.region_id = p_region_id
  ORDER BY c.kd_cabang;
$function$
;


-- --- public.get_routing_areas ---
CREATE OR REPLACE FUNCTION public.get_routing_areas(p_cabang_id uuid)
 RETURNS TABLE(id uuid, kd_dist text, nama_area text, lat numeric, lon numeric, status_code text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'mst_area', 'public'
AS $function$
  SELECT a.id, a.kd_dist, a.nama_area, a.lat, a.lon, a.status_code
  FROM mst_area.areas a
  JOIN mst_area.ldcs l ON a.ldc_id = l.id
  WHERE l.cabang_id = p_cabang_id
    AND a.is_active = true
  ORDER BY a.status_code, a.nama_area;
$function$
;


-- --- public.get_stores_by_area ---
CREATE OR REPLACE FUNCTION public.get_stores_by_area(p_area_id uuid)
 RETURNS TABLE(customer_code text, customer_name text, longitude double precision, latitude double precision, div_sls text, visit_frequency text, omset double precision, gadm_kecamatan text, gadm_kelurahan text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
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
$function$
;


-- --- public.get_plans_by_area ---
CREATE OR REPLACE FUNCTION public.get_plans_by_area(p_area_id uuid)
 RETURNS TABLE(id uuid, plan_name text, status text, divisions jsonb, summary jsonb, store_count integer, created_by uuid, created_at timestamp with time zone, approved_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
  SELECT
    p.id,
    p.plan_name,
    p.status,
    p.divisions,
    p.summary,
    COALESCE(p.store_count, (SELECT COUNT(*)::int FROM jks_engine.plan_assignments WHERE plan_id = p.id)),
    p.created_by,
    p.created_at,
    p.approved_at
  FROM jks_engine.plans p
  WHERE p.area_id = p_area_id
  ORDER BY
    CASE p.status WHEN 'APPROVED' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,
    p.created_at DESC;
$function$
;


-- --- public.get_plan_assignments ---
CREATE OR REPLACE FUNCTION public.get_plan_assignments(p_plan_id uuid)
 RETURNS TABLE(customer_code text, div_sls text, sales_person_name text, day_index smallint, day_of_week text, visit_cycle text, visit_ganjil boolean, visit_genap boolean, visit_order smallint, qc_flag text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT a.customer_code, a.div_sls, a.sales_person_name,
           a.day_index, a.day_of_week, a.visit_cycle,
           a.visit_ganjil, a.visit_genap, a.visit_order, a.qc_flag
    FROM jks_engine.plan_assignments a
    WHERE a.plan_id = p_plan_id;
END;
$function$
;


-- --- public.save_plan ---
CREATE OR REPLACE FUNCTION public.save_plan(p_plan_id uuid, p_area_id uuid, p_plan_name text, p_divisions jsonb, p_version_ids jsonb, p_summary jsonb, p_created_by uuid, p_assignments jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
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
$function$
;


-- --- public.next_plan_version ---
CREATE OR REPLACE FUNCTION public.next_plan_version(p_area_id uuid)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
    SELECT COALESCE(MAX(
        CASE WHEN p.plan_name ~ '_V[0-9]+$'
             THEN (regexp_match(p.plan_name, '_V([0-9]+)$'))[1]::int
             ELSE 0
        END
    ), 0) + 1
    FROM jks_engine.plans p
    WHERE p.area_id = p_area_id
      AND p.created_at::date = CURRENT_DATE;
$function$
;


-- --- public.approve_plan ---
CREATE OR REPLACE FUNCTION public.approve_plan(p_plan_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
DECLARE
  v_area_id uuid;
BEGIN
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
$function$
;


-- --- public.discard_plan ---
CREATE OR REPLACE FUNCTION public.discard_plan(p_plan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
BEGIN
  -- Pastikan hanya DRAFT yang bisa dihapus
  IF NOT EXISTS (
    SELECT 1 FROM jks_engine.plans WHERE id = p_plan_id AND status = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Hanya plan berstatus DRAFT yang dapat dihapus';
  END IF;

  DELETE FROM jks_engine.plan_assignments WHERE plan_id = p_plan_id;
  DELETE FROM jks_engine.plans            WHERE id      = p_plan_id;
END;
$function$
;


-- --- public.stage_stores ---
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
$function$
;


-- --- public.commit_staging ---
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

  -- Guard: session ini sudah tidak punya baris (mis. ter-wipe oleh staging lain
  -- ke area yang sama, atau sudah di-commit/discard). Jangan tampilkan sukses palsu.
  IF v_total = 0 THEN
    RETURN jsonb_build_object('upserted', 0, 'total', 0, 'empty', true);
  END IF;

  INSERT INTO jks_engine.stores (
    area_id, customer_code, customer_name,
    latitude, longitude,
    div_sls, type, omset, visit_frequency,
    gadm_provinsi, gadm_kota, gadm_kecamatan, gadm_kelurahan,
    is_active, uploaded_by
  )
  SELECT
    area_id, customer_code, customer_name,
    latitude, longitude,
    div_sls, type, omset, visit_frequency,
    gadm_provinsi, gadm_kota, gadm_kecamatan, gadm_kelurahan,
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
    is_active       = true,
    uploaded_by     = EXCLUDED.uploaded_by;

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- Bersihkan staging setelah commit
  DELETE FROM jks_engine.stores_staging
  WHERE staging_session_id = p_staging_session_id;

  RETURN jsonb_build_object('upserted', v_upserted, 'total', v_total, 'empty', false);
END;
$function$
;


-- --- public.discard_staging ---
CREATE OR REPLACE FUNCTION public.discard_staging(p_staging_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
BEGIN
  DELETE FROM jks_engine.stores_staging
  WHERE staging_session_id = p_staging_session_id;
END;
$function$
;


-- --- public.get_plan_coverage_summary ---
CREATE OR REPLACE FUNCTION public.get_plan_coverage_summary(p_plan_id uuid)
 RETURNS TABLE(kecamatan text, kelurahan text, jml_toko integer, sales_names text[])
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'jks_engine', 'public'
AS $function$
  SELECT
    s.gadm_kecamatan AS kecamatan,
    s.gadm_kelurahan AS kelurahan,
    count(*)::int     AS jml_toko,
    array_agg(DISTINCT pa.sales_person_name ORDER BY pa.sales_person_name) AS sales_names
  FROM jks_engine.plan_assignments pa
  JOIN jks_engine.plans  p ON p.id = pa.plan_id
  JOIN jks_engine.stores s ON s.customer_code = pa.customer_code AND s.area_id = p.area_id
  WHERE pa.plan_id = p_plan_id
  GROUP BY s.gadm_kecamatan, s.gadm_kelurahan
  ORDER BY s.gadm_kecamatan, s.gadm_kelurahan;
$function$
;


-- --- public.upsert_stores ---
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
  -- Caller harus authenticated
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
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
        -- Check apakah ini insert atau update dengan xmax trick
        -- xmax = 0 berarti fresh insert
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

  -- Hitung update = total sukses - inserted (approx: semua ON CONFLICT dianggap updated)
  -- Karena ON CONFLICT selalu mengembalikan found=true, kita estimate dari conflict
  -- Simplifikasi: kembalikan inserted = rows berhasil, updated = 0 (UI pakai "upserted")
  RETURN jsonb_build_object(
    'upserted', v_inserted,
    'errors',   v_errors,
    'total',    v_i
  );
END;
$function$
;


-- --- public.preview_geocode_summary ---
CREATE OR REPLACE FUNCTION public.preview_geocode_summary(p_points jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
DECLARE
  v_total     int;
  v_summary   jsonb;
  v_not_found jsonb;
  v_per_store jsonb;
  v_geocoded  int;
BEGIN
  v_total := jsonb_array_length(p_points);

  -- Geocode: Pass 1 exact PIP + Pass 2 KNN fallback (≤0.01°) via CTE
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
    SELECT p.customer_code, g.name_1, g.name_2, g.name_3, g.name_4
    FROM pts p
    JOIN jks_engine.gadm_regions g ON ST_Within(p.pt_geom, g.geom)
  ),
  fallback AS (
    SELECT p.customer_code, g.name_1, g.name_2, g.name_3, g.name_4
    FROM pts p
    CROSS JOIN LATERAL (
      SELECT name_1, name_2, name_3, name_4
      FROM jks_engine.gadm_regions
      WHERE geom && ST_Expand(p.pt_geom, 0.01)
      ORDER BY geom <-> p.pt_geom
      LIMIT 1
    ) g
    WHERE p.customer_code NOT IN (SELECT customer_code FROM exact)
  ),
  combined AS (
    SELECT customer_code, name_1, name_2, name_3, name_4 FROM exact
    UNION ALL
    SELECT customer_code, name_1, name_2, name_3, name_4 FROM fallback
  )
  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', customer_code,
    'name_1', name_1, 'name_2', name_2,
    'name_3', name_3, 'name_4', name_4
  ))
  INTO v_per_store
  FROM combined;

  -- Summary per kecamatan
  SELECT jsonb_agg(row ORDER BY jumlah DESC)
  INTO v_summary
  FROM (
    SELECT
      r->>'name_1' AS name_1,
      r->>'name_2' AS name_2,
      r->>'name_3' AS name_3,
      COUNT(*)::int                                        AS jumlah,
      ROUND(COUNT(*) * 100.0 / v_total, 1)::numeric(5,1) AS pct
    FROM jsonb_array_elements(COALESCE(v_per_store, '[]'::jsonb)) r
    GROUP BY r->>'name_1', r->>'name_2', r->>'name_3'
  ) row;

  -- Not found: tidak ketemu bahkan setelah KNN fallback
  SELECT jsonb_agg(jsonb_build_object(
    'customer_code', pt->>'customer_code',
    'lat', (pt->>'lat')::float,
    'lon', (pt->>'lon')::float
  ))
  INTO v_not_found
  FROM jsonb_array_elements(p_points) AS pt
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_per_store, '[]'::jsonb)) ps
    WHERE ps->>'customer_code' = pt->>'customer_code'
  );

  SELECT COALESCE(jsonb_array_length(v_per_store), 0) INTO v_geocoded;

  RETURN jsonb_build_object(
    'summary',   COALESCE(v_summary,   '[]'::jsonb),
    'not_found', COALESCE(v_not_found, '[]'::jsonb),
    'per_store', COALESCE(v_per_store, '[]'::jsonb),
    'total',     v_total,
    'geocoded',  v_geocoded
  );
END;
$function$
;


-- --- public.import_gadm_batch ---
CREATE OR REPLACE FUNCTION public.import_gadm_batch(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
DECLARE n int;
BEGIN
  INSERT INTO jks_engine.gadm_regions
    (name_1, name_2, name_3, name_4,
     gid_0, gid_1, gid_2, gid_3, gid_4, type_4,
     geom)
  SELECT
    r->>'name_1', r->>'name_2', r->>'name_3', r->>'name_4',
    r->>'gid_0',  r->>'gid_1',  r->>'gid_2',  r->>'gid_3',
    r->>'gid_4',  r->>'type_4',
    ST_GeomFromText(r->>'wkt', 4326)
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (gid_4) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$
;


-- --- public.truncate_gadm_regions ---
CREATE OR REPLACE FUNCTION public.truncate_gadm_regions()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'jks_engine'
AS $function$
BEGIN
  TRUNCATE jks_engine.gadm_regions RESTART IDENTITY;
END;
$function$
;
