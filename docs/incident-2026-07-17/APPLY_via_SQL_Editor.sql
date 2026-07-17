-- ============================================================================
-- JALANKAN di Supabase Dashboard → SQL Editor (project zxrurtmjpaifzjrqcayb / nabati-heroes)
-- Ini memperbaiki login admin@jks.pma. Transaksi + verifikasi: kalau hasil aneh, ganti
-- COMMIT di akhir dengan ROLLBACK — tak ada yang berubah.
-- ============================================================================
begin;

-- (A) BEFORE — konfirmasi kondisi rusak
select 'BEFORE' tahap, slot_code, scope, scope_id, job_title
  from mst_hr.dim_slots where slot_code = 'R00-00-02';

-- (B) FIX — samakan dgn slot ADMIN sehat R00-00-03 (scope '00' = HEAD OFFICE). Idempoten.
update mst_hr.dim_slots
   set scope = '00'
 where slot_code = 'R00-00-02'
   and scope is null;

-- (C) VERIFIKASI hook JKS — HARUS mengembalikan JSON berisi claims, BUKAN null
select 'hook admin@jks.pma' cek,
       public.custom_access_token_hook(
         '{"user_id":"6ac912c3-7f87-4bcf-81f3-a1fe4e02b7c1","claims":{"role":"authenticated"}}'::jsonb
       ) hasil;

-- (D) KONTROL non-regresi — user nabati-heroes sehat harus TETAP dapat claim scope '00'
select 'hook febe (kontrol)' cek,
       public.custom_access_token_hook(
         jsonb_build_object('user_id',
           (select id from auth.users where email='febe_priska@pinusmerahabadi.co.id'),
           'claims', '{"role":"authenticated"}'::jsonb)
       ) hasil;

-- (E) Tak ada ranjau tersisa — HARUS 0 baris
select 'sisa slot scope NULL' cek, count(*) jumlah
  from mst_hr.dim_slots where scope is null;

-- Kalau (C) berisi app_role & (D) masih scope '00' & (E) = 0 → COMMIT. Jika ragu → ROLLBACK.
commit;
