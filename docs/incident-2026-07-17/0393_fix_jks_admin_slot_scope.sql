-- 0393_fix_jks_admin_slot_scope.sql
-- ============================================================================
-- Perbaiki login MATI untuk akun admin@jks.pma (proyek JKS Route Engine yang
-- menumpang DB ini). Root cause TERBUKTI dari data prod (2026-07-17):
--
--   Slot R00-00-02 (job_title 000002 = ADMIN) punya scope = NULL.
--   public.custom_access_token_hook (0302) membangun claim via rantai jsonb_set:
--       v_claims := jsonb_set(v_claims, '{scope}', to_jsonb(v_scope));   -- v_scope NULL
--   jsonb_set() bersifat STRICT → argumen NULL menjadikan SELURUH v_claims NULL →
--   RETURN jsonb_set(event,'{claims}',NULL) → NULL → GoTrue MENOLAK terbitkan token.
--   (scope_id sudah di-COALESCE di 0302, scope LUPUT — makanya hanya scope NULL yang menggigit.)
--
-- Kenapa hanya 1 akun kena: R00-00-02 adalah SATU-SATUNYA baris dim_slots ber-scope NULL
--   (probe 40 user: 39 OK, 1 NULL). Slot ADMIN sejenis R00-00-03 (febe_priska) ber-scope
--   '00' dan hook-nya SUKSES → dijadikan cetakan. scope_id dibiarkan NULL (febe juga NULL, aman).
--
-- Jaring pengaman 0302 (EXCEPTION WHEN OTHERS → RETURN event) TIDAK menangkap ini karena
--   hook mengembalikan NULL, bukan melempar exception. Tambalan KODE (hook null-safe) menyusul
--   di migrasi terpisah; migrasi ini menambal DATA agar login pulih sekarang.
--
-- scope '00' = HEAD OFFICE (mst_hr.scopes). Idempoten (WHERE scope IS NULL). Pada shadow DB
--   bersih R00-00-02 tak ada (disisipkan out-of-band) → UPDATE 0 baris, replay tetap bersih.
-- ============================================================================

update mst_hr.dim_slots
   set scope = '00'          -- 00 = HEAD OFFICE
 where slot_code = 'R00-00-02'
   and scope is null;
