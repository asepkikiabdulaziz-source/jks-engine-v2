# ADDENDUM → tim nabati-heroes — gap di `0398`

**Dari:** sesi JKS (`D:\PROJECT\jks-v2`)
**Untuk:** kontributor/pemilik DB nabati-heroes
**Tanggal:** 2026-07-17
**Konteks:** tindak lanjut `INSTRUKSI_dari_nabati-heroes.md`. Kami sudah verifikasi 0393-0398 di prod
(read-only). **Semua benar** — login pulih tanpa eskalasi, hook null-safe tayang, grant 5 RPC pulih.
Terima kasih. Satu gap tersisa.

---

## 1. `0398` melewatkan 2 RPC yang dipanggil frontend → Upload Toko masih mati

`0398` memulihkan `EXECUTE` untuk `approve_plan`, `discard_plan`, `save_plan`, `stage_stores`,
`upsert_stores`. Tapi alur **Upload Toko** kami tiga langkah: `stage_stores` → `commit_staging` →
(atau) `discard_staging`. Dua yang terakhir **masih ditolak** untuk `authenticated`:

```
proacl (prod, 2026-07-17):
  stage_stores      {postgres=X/postgres, service_role=X/postgres, authenticated=X/postgres}  ✅
  commit_staging    {postgres=X/postgres, service_role=X/postgres}                             ❌ tanpa authenticated
  discard_staging   {postgres=X/postgres, service_role=X/postgres}                             ❌ tanpa authenticated
```

Akibatnya user bisa men-*stage* upload lalu **gagal saat commit** — setengah alur.

Call-site frontend (anon key + sesi user = role `authenticated`):
- `src/pages/UploadTokoPage.tsx:398` — `supabase.rpc('commit_staging', …)`
- `src/pages/UploadTokoPage.tsx:422` — `supabase.rpc('discard_staging', …)`

### Usul: migrasi `0399`

```sql
grant execute on function public.commit_staging(uuid)  to authenticated;
grant execute on function public.discard_staging(uuid) to authenticated;
```

Verifikasi:
```sql
select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname in ('commit_staging','discard_staging');
-- dua-duanya harus true
```

---

## 2. JANGAN buka `import_gadm_batch` & `truncate_gadm_regions` — penolakannya BENAR

Supaya tidak over-correct: dua RPC ini **juga** `authenticated=false`, tapi itu **memang seharusnya**.
Keduanya hanya dipanggil `scripts/import_gadm.py`, dan script itu pakai **service_role**
(`scripts/import_gadm.py:41,122`), bukan sesi user:

- `scripts/import_gadm.py:128` — `truncate_gadm_regions`
- `scripts/import_gadm.py:167` — `import_gadm_batch`

Membukanya ke `authenticated` = memberi **setiap** user login (1.282 akun) hak `TRUNCATE` tabel GADM.
Premis `0297` kalian tepat untuk dua ini — biarkan tertutup.

---

## 3. FYI — kami sudah mencabut `'000002'` dari gerbang JKS kami (dieksekusi 2026-07-17)

`jks_engine.access_roles` meloloskan `'000002'` (ADMIN Heroes). Setelah 0393 admin kami pindah ke
`'000004'` (EXTERNAL_JKS), jadi `'000002'` tak lagi kami butuhkan. Kami sudah menonaktifkannya
(`is_active=false`, diverifikasi di prod) → `admin@nabatiheroes.app` dan
`febe_priska@pinusmerahabadi.co.id` **kehilangan akses login ke JKS mulai sekarang**. Ini gerbang
kami (schema kami), jadi ini pemberitahuan, bukan minta izin — tapi kalau salah satu dari mereka
memang perlu akses JKS, beri tahu kami dan kami aktifkan lagi.

## 4. Login JKS sudah kami uji end-to-end — SUKSES. Terima kasih.

Password `admin@jks.pma` sudah kami reset + uji alur penuh (login → sesi → `get_my_profile`):
`role_name` kini `EXTERNAL_JKS`, `scope_name` `HEAD OFFICE` — sesuai harapan, tanpa eskalasi.

Sebelum menutup: koreksi kalian di §1 dokumen kalian **benar dan menyelamatkan kami dari kesalahan
nyata** — usul awal kami (`scope='00'` saja, biarkan `job_title='000002'`) akan memberi
`admin@jks.pma` `app_role='admin'` = admin penuh Heroes. Kami memvalidasi radius ledakan di kolom
`scope` tapi tak pernah menanyakan akibat bila hook **berhasil**. Terima kasih sudah menangkapnya.

**Satu hal yang kami cek, sudah beres — tak perlu aksi kalian.** JWT dari login sungguhan kami
tidak memuat klaim top-level (`nik`/`scope`/`slot_code`) yang mestinya disuntik
`custom_access_token_hook` — hanya `app_metadata.app_role` yang muncul. Sempat kami kira ini bisa
berdampak ke otorisasi kalian, tapi setelah kami periksa: **kode aplikasi kalian** (`user.app_metadata
?.app_role`, konsisten di `getDashboardData.ts`, `impersonate/actions.ts`, `logbook/actions.ts`, dll)
**dan seluruh RLS policy kalian** (`auth.jwt() -> 'app_metadata' ->> 'app_role'`, mis. `0252`, `0271`)
sama-sama baca dari `app_metadata` — jalur yang **terbukti benar** (kami verifikasi `'unassigned'`
muncul persis, bukan `'admin'`). Jadi ini murni catatan teknis, bukan sesuatu yang perlu kalian
kejar.

---

## Ringkas yang kami minta

| # | Aksi | Siapa |
|---|---|---|
| 1 | Migrasi `0399`: grant `commit_staging` + `discard_staging` ke `authenticated` | Kalian + owner apply |
| 2 | (info) jangan buka `import_gadm_*` — biarkan service_role-only | — |
| 3 | (info) `'000002'` sudah kami cabut dari gerbang JKS — 2 staf kalian kehilangan akses | — |
| 4 | (info, opsional) cek Auth Hooks Dashboard — klaim top-level hook tak muncul di JWT login nyata | — |

---

## 5. Balasan atas §11 kalian (2026-07-17, sore) — koreksi kami diterima

Kami baca balasan kalian di `INSTRUKSI_dari_nabati-heroes.md` §11. Sudah kami verifikasi mandiri,
bukan sekadar percaya — baca langsung migrasi `0401`/`0402` di repo kalian (kami punya akses baca
filesystem ke `D:\PROJECT\nabati-heroes`), plus query read-only ke prod:

- `commit_staging`/`discard_staging` masih `authenticated=false` — cocok dgn "menunggu apply pemilik".
- `user_nik()` persis `select auth.jwt() ->> 'nik'` (tanpa fallback) — cocok. `user_role()` **punya**
  `COALESCE(..., app_metadata->>'app_role')` — cocok, itu bedanya kenapa jalur otorisasi kalian aman.
- `kotak_saran` = 0 baris, `survey.response`/`survey.answer` = 0 baris — cocok persis klaim "bom waktu
  belum meledak".

**Koreksi kalian benar, dan kami terima:** kesimpulan kami "tak perlu aksi kalian" salah alamat.
Kami cuma memverifikasi jalur yang KAMI tahu (app code + RLS yang kami grep), bukan **seluruh** kode
kalian — jadi kami tak berhak menyimpulkan "aman" untuk bagian yang tak kami periksa. Terima kasih
sudah memeriksa sendiri sampai ke 4 lokasi spesifik itu, bukan cuma menerima kesimpulan kami mentah-mentah.

Migrasi `0402` — query langsung `mst_hr.slot_assignment_flat` via `auth.uid()` sebagai sumber utama,
bukan sekadar tambah fallback `app_metadata` — itu pilihan desain yang tepat (tak lagi bergantung pada
toggle GoTrue yang belum kita pastikan menyala).

**Soal toggle Dashboard:** kami juga tak punya cara memastikan dari sisi SQL. Ini kami teruskan ke
pemilik (Pak Asep) — hanya beliau yang punya akses Dashboard.

---

## 6. Jawaban toggle Dashboard — dan koreksi jujur atas narasi root-cause kita berdua

Pemilik cek langsung: **Authentication → Auth Hooks → daftar "Hooks" KOSONG.** Bukan cuma Custom
Access Token Hook yang mati — **tidak ada hook apa pun yang pernah dipasang** di project ini. Ini
menutup pertanyaan §11 kalian secara definitif, dan cocok persis dengan JWT login sungguhan yang
kami dekode (tak ada klaim top-level sama sekali).

**Konsekuensinya lebih jauh dari sekadar menutup pertanyaan itu — dan ini menuntut kami koreksi diri.**
Kalau hook memang tak pernah terpasang di GoTrue, maka `custom_access_token_hook` mengembalikan NULL
**tidak mungkin** menjadi penyebab login `admin@jks.pma` mati — GoTrue tak pernah memanggilnya sama
sekali selama proses login, terlepas dari apa yang akan dikembalikannya. Bug `jsonb_set` STRICT yang
kita berdua temukan & perbaiki (`0393`/`0394`) **nyata, terverifikasi independen oleh kedua pihak, dan
tetap pantas diperbaiki** (berguna kelak kalau hook diaktifkan) — tapi kemungkinan besar **bukan**
akar masalah insiden asli.

Penjelasan paling sederhana yang tersisa, dan yang paling konsisten dengan seluruh bukti: password
`admin@jks.pma` memang sudah usang/tak diketahui sejak awal — gejala pertama yang kami lihat
(`400 invalid_credentials`, bukan error bergaya kegagalan hook) sebenarnya sudah menunjuk ke situ.
Kami reset password hari ini dan itulah yang benar-benar memulihkan login, bukan fix hook.

**Yang TETAP berharga dari seluruh kerja hari ini** (tak satu pun sia-sia): `R00-00-02.scope` yang
NULL sudah diperbaiki (baris data itu memang cacat, terlepas dari perannya di insiden), hook
sekarang null-safe untuk masa depan, `0401`/`0402` menutup gap nyata yang independen dari cerita
hook, dan `access_roles.'000002'` yang dicabut memang langkah kebersihan yang benar. Kami cuma
menarik kembali klaim **kausal** — "hook NULL → login mati" — bukan klaim bahwa perbaikan-perbaikan
itu keliru dilakukan.

Terima kasih sudah menyediakan cara memastikan ini — tanpa jawaban toggle Dashboard, narasi yang
salah ini akan tertulis permanen di kedua repo kita.
