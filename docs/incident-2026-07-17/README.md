# Insiden 2026-07-17 — Login JKS mati total

> ## ✅ STATUS: RESOLVED. Login pulih — tapi baca koreksi root-cause di bawah dulu.
>
> **Yang benar-benar memulihkan login: reset password.** Setelah investigasi panjang (di bawah),
> pemilik cek **Supabase Dashboard → Authentication → Auth Hooks: daftar hook KOSONG** — tidak ada
> hook apa pun (termasuk `custom_access_token_hook`) yang pernah terpasang di project ini.
>
> **Artinya seluruh teori "hook NULL → GoTrue tolak terbitkan token" — yang kami & tim nabati-heroes
> bangun bersama dan yakini benar — kemungkinan besar SALAH sebagai penyebab insiden ini.** Kalau
> hook tak pernah dipanggil GoTrue, NULL atau tidaknya hasilnya tak relevan bagi login sungguhan.
> Penjelasan paling sederhana yang konsisten dengan SEMUA bukti (termasuk gejala awal `400
> invalid_credentials` — bukan error bergaya kegagalan hook): **password `admin@jks.pma` memang
> sudah usang/tak diketahui sejak awal.** Reset password itulah yang memulihkan login, bukan fix hook.
>
> **Ini TIDAK berarti kerja hari ini sia-sia** — lihat "Apa yang tetap berharga" di bawah. Tapi kalau
> Anda cuma baca satu baris di dokumen ini: *diagnosis awal kami keliru soal mekanisme, meski
> perbaikan yang dihasilkan tetap berguna.*

---

## Kronologi ringkas (untuk pembaca baru)

1. **Gejala:** `admin@jks.pma` tak bisa login. App, DB, skema, RPC, data — semua SEHAT.
2. **Teori awal (SALAH sebagai penyebab, TERBUKTI sebagai bug nyata):** `custom_access_token_hook`
   milik nabati-heroes membangun claims via rantai `jsonb_set()` yang **STRICT** (argumen NULL →
   hasil NULL). Slot `mst_hr.dim_slots.R00-00-02` (ADMIN JKS) punya `scope=NULL` → saat hook
   dipanggil manual via SQL, ia mengembalikan NULL. Kami (dan independen, tim nabati-heroes)
   menyimpulkan ini yang membuat GoTrue menolak menerbitkan token.
3. **Kedua tim memperbaiki teori itu:** Heroes menulis `0393` (isi posisi `EXTERNAL_JKS`) + `0394`
   (hook jadi null-safe, `jsonb_build_object` + guard). Kami memverifikasi via probe 40 user (39 OK,
   1 NULL) dan transaksi rollback. Semua terbukti benar **sebagai perbaikan bug** — tapi belum ada
   yang menguji apakah hook itu **benar-benar dipanggil GoTrue sama sekali.**
4. **Password direset** (2026-07-17) — login **berhasil** end-to-end.
5. **Anomali ditemukan saat verifikasi:** JWT dari login sungguhan tak memuat klaim top-level
   (`nik`/`scope`/`slot_code`) yang mestinya disuntik hook.
6. **Jawaban definitif:** Dashboard → Auth Hooks kosong. **Hook tak pernah terpasang.** Teori di
   langkah 2 gugur sebagai penyebab; password usang yang sebenarnya menjelaskan semuanya.

## Apa yang tetap berharga (tak satu pun sia-sia)

- **`R00-00-02.scope` NULL tetap baris data yang cacat** — sudah benar diperbaiki (`scope='00'`),
  terlepas dari perannya di insiden ini.
- **Hook sekarang null-safe untuk masa depan** — kalau nanti hook diaktifkan Dashboard, kelas bug
  `jsonb_set` STRICT ini sudah mati duluan.
- **`0401`/`0402` (gap Upload Toko + bug `user_nik`/`survey_*`/`kotak_saran` di kode Heroes sendiri)**
  — sama sekali independen dari cerita hook, murni gap grant + bug JWT-claim yang nyata.
- **`access_roles.'000002'` yang dicabut** — kebersihan akses yang tetap benar dilakukan.
- **Baseline migrasi + runner + draft guard otorisasi** (lihat bawah) — utang struktural nyata,
  tak bergantung pada narasi insiden ini sama sekali.

**Yang gugur:** klaim bahwa `admin@jks.pma` tak bisa login **karena** hook NULL. Itu saja.

## Isi folder

| File | Status | Keterangan |
|---|---|---|
| `INSTRUKSI_dari_nabati-heroes.md` | ✅ balasan Heroes | Kesepakatan kerja lintas-project: kepemilikan schema, aturan migrasi, SSO, §11 balasan atas addendum. **Baca ini.** |
| `ADDENDUM_gap_0398.md` | ✅ 2 putaran selesai | Gap `0398`→`0401`, bug `user_nik`/`survey_*`→`0402`, §6 koreksi root-cause (hook tak pernah terpasang). |
| `BRIEFING_untuk_nabati-heroes.md` | ✅ terkirim (historis) | Briefing awal yang memicu respons Heroes. |
| `APPLY_via_SQL_Editor.sql` | ❌ **USANG — jangan jalankan** | Fix pertama kami yang salah (akan eskalasi hak). Jejak saja. |
| `0393_fix_jks_admin_slot_scope.sql` | ❌ **USANG — jangan jalankan** | Idem. Heroes pakai `0393` versi mereka (`job_title='000004'`). |

## Sisa pekerjaan aktual

1. ~~Di sisi Heroes: apply `0401`+`0402`~~ — **SELESAI**, terverifikasi live (`commit_staging`/
   `discard_staging` grant pulih, `user_nik` pakai `slot_assignment_flat` langsung).
2. ~~Di sisi JKS: guard `auth.uid()` (C1)~~ — **SELESAI, dengan satu putaran regresi-dan-fix**:
   `0003_guard_authz_rpc.sql` diterapkan (dikonfirmasi pemilik), lalu ketahuan merusak
   `/generate-plan` (`save_plan` dipanggil `api.py` via service_role, `auth.uid()` NULL) →
   diperbaiki `0004_fix_save_plan_service_role_guard.sql` (guard terima `COALESCE(auth.uid(),
   p_created_by)`). Keduanya terverifikasi HTTP sungguhan pasca-commit, bukan cuma simulasi.

## Kenapa ini bisa jebol (masih relevan, terlepas dari koreksi root-cause)

Dokumen nabati-heroes menulis *"`jks_engine` = proyek LAIN — JANGAN sentuh"* — pagar itu melindungi
**SCHEMA**. Tapi identitas JKS hidup di `mst_hr.dim_slots` + `auth.users`, dan grep
`R00-00-02|99999998|jks.pma` di seluruh repo mereka (sebelum diperbaiki) = **0 hasil**. Pagarnya ada
di tempat yang salah. Ini masih pelajaran berharga meski bukan penyebab literal insiden: baris data
cacat (`scope=NULL`) tetap ada di sana, tak terlabeli, sampai investigasi ini menemukannya.

## Utang terkait (status 2026-07-17 sore)

- [x] **Baseline migrasi SQL** — `scripts/dump_baseline.py` (pg_dump tak ada di mesin ini, dibangun
      via introspeksi `pg_get_functiondef`+`information_schema`) → `supabase/migrations/0001_baseline.sql`.
- [x] **Runner migrasi** — `scripts/run_migrations.py` + ledger `jks_engine._migrations` (0001&0002 tercatat).
- [ ] **Otorisasi terbalik**, `api.py:111` — `_verify_jwt` menerima JWT **siapa pun** dari GoTrue
      bersama. Guard DB-level sudah didraft (`0003` di atas); guard di `api.py` sendiri (C1, lihat
      ROADMAP.md) masih terbuka.
