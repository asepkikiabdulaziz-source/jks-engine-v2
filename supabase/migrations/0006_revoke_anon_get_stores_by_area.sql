-- 0006_revoke_anon_get_stores_by_area.sql
-- Tutup kebocoran BACA TANPA LOGIN pada public.get_stores_by_area.
--
-- ============================================================================
-- APA YANG BOCOR
-- ============================================================================
-- Terverifikasi di prod (transaksi rollback, 2026-08-04):
--
--   set local role anon;                       -- tanpa sesi, auth.uid() = NULL
--   select count(*) from public.get_stores_by_area('<area>', '<uuid anggota JKS>');
--   -> 371 baris KELUAR
--
-- Rantainya:
--   1. Guard 0005 memakai COALESCE(auth.uid(), p_caller_id). Untuk pemanggil anon
--      auth.uid() NULL -> jatuh ke p_caller_id, yang DIKENDALIKAN KLIEN.
--   2. `anon` punya EXECUTE (lihat bawah) -> jalur itu bisa dijangkau tanpa login.
--   3. anon key publik by design (dikirim ke browser via window.__ENV__ di api.py).
--   4. UUID anggota JKS ada di repo PUBLIK (tests/test_rpc_authz.py:42).
--
-- Hasil: customer_code + customer_name + lat/lon + omset milik AREA MANA PUN bisa
-- ditarik siapa saja, tanpa akun. Guard 0005 tidak pernah menghalangi jalur ini
-- karena ia mengecek KEANGGOTAAN, sementara identitas yang dicek justru datang
-- dari parameter si pemanggil sendiri.
--
-- ============================================================================
-- KENAPA `anon` PUNYA EXECUTE (ini bagian yang akan terulang)
-- ============================================================================
-- Bukan karena ada yang meng-GRANT-nya. Dua default bekerja bersamaan saat 0005
-- menjalankan DROP FUNCTION + CREATE:
--
--   (a) Postgres      : CREATE FUNCTION otomatis -> EXECUTE TO PUBLIC.
--   (b) Supabase      : ALTER DEFAULT PRIVILEGES IN SCHEMA public
--                       GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role.
--
-- ACL sebelum migrasi ini (information_schema.role_routine_grants):
--   PUBLIC EXECUTE | anon EXECUTE | authenticated EXECUTE | service_role EXECUTE | postgres EXECUTE
--
-- Artinya: SETIAP DROP+CREATE fungsi JKS di schema `public` akan memberi `anon`
-- akses lagi, DIAM-DIAM. CREATE OR REPLACE mempertahankan ACL; DROP membuangnya
-- lalu default di atas mengisinya kembali. Inilah kenapa hanya fungsi INI yang
-- bocor -- cuma ini yang di-DROP (0003/0004 memakai CREATE OR REPLACE saja).
--
-- Konsekuensi lintas-repo: nabati-heroes 0412 menangkap 0005 dengan DROP+CREATE
-- yang sama dan JUGA tanpa GRANT/REVOKE -> replay riwayat mereka akan MELAHIRKAN
-- ULANG lubang ini. Perlu dikabarkan; doktrinnya sudah mereka tulis sendiri di
-- 0398 ("mutasi + SECURITY DEFINER + bisa dijangkau anon = celah nyata"), tinggal
-- diterapkan ke fungsi baca ini juga.
--
-- ============================================================================
-- PERBAIKAN
-- ============================================================================
-- GRANT dulu, REVOKE kemudian -- urutan ini WAJIB. Kalau REVOKE ... FROM public
-- dijalankan lebih dulu sementara akses `authenticated` ternyata hanya menumpang
-- PUBLIC, 4 pemanggil browser di src/ mati seketika. GRANT eksplisit di depan
-- membuat migrasi ini benar apa pun keadaan ACL awalnya, dan idempoten.
--
-- CATATAN CAKUPAN: ini menutup jalur ANON saja -- itu yang diminta dan itu yang
-- bisa dieksploitasi hari ini tanpa akun. Dua kelemahan TETAP TERBUKA dan sudah
-- tercatat sebagai temuan terpisah:
--   * p_caller_id masih parameter yang dikendalikan klien (aman selama hanya
--     service_role yang auth.uid()-nya NULL, tapi rapuh secara desain);
--   * guard masih biner "anggota JKS", BUKAN scope area -- C1 versi asli
--     ("akses lintas-area") belum tertutup.
-- Keduanya hilang sendiri bila FastAPI dijadikan pintu tunggal ke DB JKS.

-- 1) Pastikan pemakai sah punya EXECUTE eksplisit (idempoten; tidak menumpang PUBLIC).
--    authenticated -> 4 pemanggil browser di src/ (sesi user, auth.uid() terisi).
--    service_role  -> 3 endpoint api.py (/stage1, /stage2, /generate-plan).
grant execute on function public.get_stores_by_area(uuid, uuid) to authenticated, service_role;

-- 2) Cabut jalur tanpa-login.
revoke execute on function public.get_stores_by_area(uuid, uuid) from anon, public;

-- 3) Verifikasi di dalam transaksi yang sama -- gagal keras, jangan lolos senyap.
--    Kalau salah satu asersi ini meleset, seluruh migrasi di-rollback oleh runner.
do $$
begin
  if has_function_privilege('anon', 'public.get_stores_by_area(uuid,uuid)', 'EXECUTE') then
    raise exception 'REVOKE gagal: anon MASIH punya EXECUTE pada get_stores_by_area';
  end if;

  if not has_function_privilege('authenticated', 'public.get_stores_by_area(uuid,uuid)', 'EXECUTE') then
    raise exception 'authenticated kehilangan EXECUTE -- 4 pemanggil browser di src/ akan rusak';
  end if;

  if not has_function_privilege('service_role', 'public.get_stores_by_area(uuid,uuid)', 'EXECUTE') then
    raise exception 'service_role kehilangan EXECUTE -- 3 endpoint api.py akan rusak';
  end if;
end $$;

-- ============================================================================
-- VERIFIKASI (di luar migrasi)
-- ============================================================================
--   python -m pytest tests/ -v -k anon      -> regresi terkunci
--
--   Manual, persis jalur eksploitasi:
--     begin;
--       set local role anon;
--       select count(*) from public.get_stores_by_area('<area>'::uuid, '<uuid anggota>'::uuid);
--     rollback;
--   Sebelum: 371 baris.  Sesudah: ERROR 42501 permission denied for function.
--
-- LANGKAH LANJUTAN (bukan di migrasi ini):
--   Jadikan pemeriksaan ACL langkah wajib di scripts/run_migrations.py -- tiap
--   DROP FUNCTION di schema `public` menyalakan ulang default privileges Supabase,
--   dan tak ada satu pun test yang menangkapnya sebelum ini.
