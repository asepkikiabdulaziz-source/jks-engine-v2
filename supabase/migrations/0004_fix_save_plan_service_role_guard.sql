-- 0004_fix_save_plan_service_role_guard.sql
-- Perbaiki REGRESI dari 0003: save_plan (BEDA dari 4 RPC lain yang di-guard) dipanggil
-- api.py:506 lewat client SERVICE_ROLE (`_db()` — singleton, docstring api.py:91 "Service-role
-- Supabase client — bypass RLS"), BUKAN dari browser dgn sesi user. JWT service_role tak
-- punya klaim `sub` (dikonfirmasi 2026-07-17: {"iss":"supabase","role":"service_role",...} —
-- nol `sub`) -> auth.uid() NULL dlm konteks itu -> guard 0003 salah menolak /generate-plan
-- yang SAH. Diverifikasi: curl pakai SUPABASE_SERVICE_KEY -> 42501 "Akses ditolak" (regresi nyata).
--
-- FIX: guard terima auth.uid() ATAU p_created_by sbg identitas. p_created_by AMAN dipakai di
-- sini KHUSUS krn api.py:513 mengisinya dari `user_id: str = Depends(_verify_jwt)` (api.py:312)
-- -- diverifikasi SERVER via db.auth.get_user(token) thd GoTrue, BUKAN field body yang bisa
-- dipalsukan klien. Efek samping (BUKAN kelonggaran baru, INI PENGERASAN): user Heroes yang
-- curl /generate-plan langsung (dry_run=false) kini JUGA ditolak DI DALAM save_plan, karena
-- user_id mereka (jadi p_created_by) tetap dicek thd jks_engine.access_roles -- C1 utk jalur
-- INI (save via api.py) tertutup lebih rapat drpd sebelum 0003, bukan cuma dipertahankan.
--
-- 4 RPC lain (approve_plan/discard_plan/stage_stores/get_my_profile) TIDAK disentuh -- semua
-- dipanggil browser dgn sesi user (auth.uid() terisi benar), dikonfirmasi via grep repo penuh
-- (api.py, src/, scripts/, supabase/functions/) -- upsert_stores tak dipanggil di mana pun saat
-- ini (orphan), tak ada regresi utk itu juga.

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
       WHERE saf.auth_user_id = COALESCE(auth.uid(), p_created_by)   -- was: auth.uid() saja
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

-- ============================================================================
-- VERIFIKASI
-- ============================================================================
--   1. service_role (api.py) dgn p_created_by = admin JKS -> HARUS lolos guard:
--      curl .../rpc/save_plan -H "Authorization: Bearer $SERVICE_KEY" \
--        -d '{"p_created_by":"6ac912c3-...", ...}' -> lolos (gagal di constraint lain, bukan 42501)
--   2. service_role dgn p_created_by = user Heroes (tanpa access_roles) -> HARUS ditolak 42501
--   3. browser (anon+sesi user asli, auth.uid() terisi) -> perilaku sama seperti 0003, tak berubah
