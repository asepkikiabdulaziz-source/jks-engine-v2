# JKS Route Engine v2 — Claude Code Context

> Diperbarui: **2026-09-02**. Bagian "Keadaan sekarang" & "Pending" diverifikasi ke DB live
> pada tanggal itu, bukan disalin dari sesi sebelumnya.

## Project Root
`D:\PROJECT\jks-v2`

---

## ⛔ KEADAAN SEKARANG — aplikasi produksi MATI, disengaja

**Sejak 2026-08-05, JKS dicabut dari DB bersama.** Bukan bug, bukan insiden. Migrasi
nabati-heroes `0525_drop_jks_rpc_dari_public.sql` menghapus **17 RPC JKS** dari schema
`public`, dengan alasan tertulis di berkasnya: *"keputusan pemilik repo 2026-08-05: JKS
memisahkan diri ke project Supabase sendiri, dan produknya dianggap dimatikan dari sisi DB
bersama ini."* Disusul `0526` (memindahkan `gadm_kecamatan`/`gadm_provinsi` — tabel milik
mereka — ke schema `geo`) dan `20260805110854` (mencabut `mst_hr.v_identity_external_v1`).

**Diverifikasi langsung ke prod, 2026-09-02 (psycopg2 read-only):**

| | |
|---|---|
| RPC JKS di `public` | **3 dari 20** tersisa (`get_routing_regions` / `_cabangs` / `_areas`) |
| Yang hilang | `get_my_profile`, `get_stores_by_area`, `save_plan`, `stage_stores`, `commit_staging`, `discard_staging`, `approve_plan`, `discard_plan`, `get_plans_by_area`, `get_plan_assignments`, `next_plan_version`, `upsert_stores`, … |
| Data `jks_engine` | **UTUH, tak disentuh** — `stores` 22.674 · `plans` 24 · `plan_assignments` 20.537 · `gadm_regions` 77.473 · `access_roles` 2 |
| Ledger `jks_engine._migrations` | berhenti di **`0006`**. `0007`–`0010` belum pernah menyentuh DB mana pun kecuali sandbox Docker lokal |
| `jks_engine.admin_regions` | **TIDAK ADA** di prod (konfirmasi 0007/0008 belum diterapkan) |
| `tests/test_rpc_authz.py` | **33 gagal / 3 lulus** — merah karena RPC-nya sudah tidak ada, bukan karena regresi kode |

**Artinya:** login, peta, upload toko, generate plan — semuanya mati. Jangan mencoba
"memperbaiki" apa pun di DB lama; tidak ada lagi yang bisa diperbaiki di sana. Heroes juga
merombak besar `mst_hr` sepanjang Agustus (`slot_assignment_flat` → `slot_row`, tahap T5–T16),
jadi `get_my_profile` lama **tak akan cocok lagi** walau RPC-nya dikembalikan.

**Langkah berikutnya = provisioning project Supabase baru** dengan identitas sendiri, bukan
patch DB lama. Lihat §Pending.

---

## Stack Cepat
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + Leaflet
- **Backend**: Python 3.11 FastAPI (`api.py` di root, bukan di `route_engine/`)
- **DB**: Supabase (PostgreSQL) — semua akses client via RPC `SECURITY DEFINER`
- **Auth**: Supabase Auth — JWT diverifikasi di FastAPI via `db.auth.get_user(token)`
  (⚠️ jalur ini bersandar pada GoTrue DB bersama — ikut mati, lihat di atas)

## Peta dokumen (baca sesuai kebutuhan)

| Dokumen | Isi |
|---|---|
| `docs/VISI.md` | **Arah produk (2026-08-04, BELUM DIKUNCI).** Platform publik niche FMCG; tiga lapis Potensi/Simulasi/Perencanaan; `n_sales` jadi keluaran, bukan masukan. **Baca sebelum ROADMAP** |
| `docs/ML.md` | Di mana ML masuk & di mana tidak. Aturan keras: ML **selalu** di lapis enrichment, **tak pernah** di dalam `route_engine/` (determinisme). Termasuk survei klaim "AI" pesaing |
| `docs/pilot/` | Paket tes distributor kedua — protokol, template, runner offline. Siap, sengaja ditunda |
| `docs/ROADMAP.md` | Rencana kerja tool internal (item A–F). ⚠️ **Usang sebagian** sejak `VISI.md`, dan §Lintas-isu-nya kini juga usang karena pencabutan 08-05 — ditulis ulang setelah arah dikunci |
| `docs/incident-2026-07-17/` | Arsip insiden login mati: root cause, SQL perbaikan, briefing utk nabati-heroes. **Historis** — gap `0398` di dalamnya sudah tak relevan |
| `AUDIT.md` | Audit keamanan 2026-06-06. C1 ✅ & M5 ✅ selesai; H1/H2/M1–M4/M6–M8 masih terbuka |
| `TECHNICAL.md` | Arsitektur detail: FE, engine, endpoint, schema (⚠️ tanpa DDL, dan ⚠️ menggambarkan jalur DB yang kini mati) |

---

## Aturan Kritis

### 0. ⚠️ DB `zxrurtmjpaifzjrqcayb` BUKAN milik kita — dan kopling itu sudah DIPUTUS

Supabase `zxrurtmjpaifzjrqcayb` dimiliki & dikelola aktif oleh project **nabati-heroes**
(`D:\PROJECT\nabati-heroes` — 500+ migrasi, commit harian). JKS **numpang**, dan sejak
2026-08-05 tumpangan itu **diakhiri** (lihat §Keadaan sekarang).

Yang masih berlaku sebagai prinsip, terlepas dari pencabutan:

- `auth.users`, `mst_hr`, dan RPC di schema `public` adalah **permukaan bersama**. Perubahan
  sah di sisi mereka bisa menjatuhkan JKS **tanpa jejak apa pun di repo ini** — pencabutan
  `0525` adalah contoh paling telanjang dari prinsip ini, tapi bukan yang pertama.
- **Kalau login gagal, jangan buru-buru simpulkan mekanismenya.** Insiden 07-17: kedua tim
  menyimpulkan bug `custom_access_token_hook` (`jsonb_set` STRICT + `scope=NULL`) — bug itu
  **nyata dan sudah diperbaiki**, tapi **bukan penyebabnya**. Dashboard Auth Hooks mereka
  kosong; hook tak pernah terpasang di GoTrue. Root cause literal: **password admin usang**.
  Verifikasi tiap lapis (password → hook → grant → guard) sebelum menuduh satu penyebab.
  Kronologi: `docs/incident-2026-07-17/README.md`.
- **`DROP FUNCTION` di schema `public` MENGHIDUPKAN akses `anon`.** `CREATE OR REPLACE`
  mempertahankan ACL; `DROP` + `CREATE` membuangnya, lalu default privileges Supabase
  mengisinya kembali — diam-diam, tanpa error, tanpa jejak di diff DDL. Ini yang membocorkan
  371 baris toko tanpa login (ditutup `0006`). **Setiap `DROP FUNCTION` wajib diikuti
  `GRANT … TO authenticated, service_role;` DULU, baru `REVOKE … FROM anon, public;`.**
- **Sebelum menambah guard `auth.uid()` ke RPC mana pun, cek dulu siapa pemanggilnya.**
  `SECURITY DEFINER` yang dipanggil lewat client `service_role` (`api.py` `_db()`) melihat
  `auth.uid()` = NULL → guard menolak jalur yang sah. Pola aman:
  `COALESCE(auth.uid(), p_created_by | p_caller_id)`, dengan parameter itu **diisi server**
  dari `Depends(_verify_jwt)`, bukan dari body client.
- **`CREATE OR REPLACE FUNCTION` dengan jumlah parameter berbeda TIDAK mengganti fungsi lama**
  — ia menambah *overload* baru dan membuat panggilan lama jadi ambigu. Perlu
  `DROP FUNCTION` eksplisit lebih dulu (lalu ingat aturan ACL di atas).

Kepemilikan schema (kesepakatan 2026-07-17): JKS = `jks_engine` (data) + `jks` (RPC, belum
dipakai); Heroes = `public` + `mst_hr`/`mst_area`/`geo`/dll + identitas & setelan API.

### 1. Akses DB dari Frontend — selalu via RPC
Tabel di `jks_engine` **tidak bisa** di-query langsung dari client karena `authenticated`
tidak punya `USAGE` grant pada schema itu. Selalu RPC `SECURITY DEFINER`:
```typescript
// SALAH — akan gagal dengan permission error
supabase.from('jks_engine.stores').select(...)

// BENAR
supabase.rpc('get_stores_by_area', { p_area_id: area.id })
```

### 2. api.py ada di ROOT, bukan di route_engine/
`route_engine/api.py` hanya stub re-export. Entry point asli:
```
D:\PROJECT\jks-v2\api.py
```
Dev server: `python start_engine.py` (load `.env.local` otomatis)

### 3. Leaflet + React — pola useRef wajib
Jangan pernah rebuild Leaflet map di setiap render. `useRef` untuk map + layer, `useEffect`
dengan `[]` untuk init. Untuk callback (onClick dst.) pakai pola `onClickRef` agar tidak
stale closure.

### 4. DivStage state machine
```
idle → s1_running → s1_done → s2_running → s2_preview → s2_saving → s2_done
```
- `s1_done`: territories ada, jadwal belum → bisa reassign toko antar sales (Tahap 2)
- `s2_preview`: jadwal ada → bisa lihat schedule + save

⚠️ Terdokumentasi rapi di sini, tapi di kode tersebar di 21 `useState` dalam satu file 2.420
baris (`RoutingEnginePage.tsx`) — tak ada satu objek pun yang memegang alurnya. Dugaan
terkuat penyebab keluhan lama "alur kurang runut".

### 5. Engine — dua jalur di /generate-plan
- **Path A** (`div.territories != null`): skip K-Means, pakai territories yang sudah ditetapkan
- **Path B** (`div.territories == null`): jalankan K-Means baru

Sejak 2026-08-05 **Path A juga menjalankan QC + summary** (sebelumnya mengembalikan `None`
dan `{}` — gap AUDIT). Dikunci `tests/test_path_a.py` (14 test, murni lokal).

### 6. Sales name format
Format: `{kd_dist}-{div_sls}-{nomor:02d}` → contoh: `1000596-TX2DA-01`
Display: `salesLabel()` di `RoutingEnginePage` → `TX2DA-SLS-01`

### 7. Doktrin engine — fail-loud, tanpa fallback senyap
Deterministik (input sama → output identik byte-per-byte), no-network, dan **menolak
terang-terangan** daripada menyimpang diam-diam:
- `KMeansConstrained` REQUIRED, tanpa fallback algoritma. Absen → engine tolak start.
- `balance_criterion=ROUTE_LENGTH` → `NotImplementedError` di **dua** gerbang
  (`PlanConfig.__post_init__` + `balanced_partition()`). Dulu diterima lalu diam-diam
  diperlakukan COUNT.
- `visit_frequency` dinormalkan dari data, **tanpa** default senyap ke BIWEEKLY.
- Contiguity teritori **diukur & dilaporkan**, tidak dipaksa (`core/contiguity.py`).

Apa pun yang butuh jaringan atau pembelajaran (OSRM, ML, geocoding) berjalan di **lapis
enrichment di luar engine**, hasilnya masuk sebagai data berversi. Lihat `docs/ML.md` §2.

---

## File Penting
| File | Keterangan |
|------|-----------|
| `api.py` | FastAPI entry point (ROOT) — `/stage1`, `/stage2`, `/generate-plan`, `/health` |
| `route_engine/engine.py` | `RouteEngine` — `partition_sales()` + `partition_days()` + `run()` |
| `route_engine/core/scheduling.py` | `build_blocking`, `build_traffic` (penempatan hari murni K-Means) |
| `route_engine/core/partition.py` | `balanced_partition` (KMeansConstrained, fail-loud) |
| `route_engine/core/contiguity.py` | Ukur keterhubungan teritori — laporkan, jangan paksa |
| `supabase/migrations/` | `0001`–`0010`. **Terbukti replay bersih dari nol** — rantai inilah yang akan dipakai provisioning project baru |
| `scripts/local-dev/` | ⚠️ **BUKAN migrasi resmi.** Shim `auth`/`mst_hr`/`mst_area` + seeder COD-AB untuk replay ke Postgres Docker kosong |
| `scripts/import_codab.py` | Impor batas wilayah COD-AB (pengganti GADM) |
| `scripts/pilot_run.py` | Runner offline tes distributor — CSV masuk, HTML+CSV keluar, nol DB |
| `src/pages/RoutingEnginePage.tsx` | Halaman utama — peta + panel + adjustment (2.420 baris) |
| `src/context/AreaContext.tsx` | State area aktif (Region → Cabang → Area) |
| `supabase/functions/generate-plan/index.ts` | Edge Function — **jalur MATI**, browser panggil FastAPI langsung |

## Kontrak RPC — definisinya di migrasi, BUKAN lagi di DB bersama

20 RPC di bawah adalah **kontrak yang dipegang `supabase/migrations/0001`–`0010`**. Di DB
bersama, 17 di antaranya sudah dihapus (§Keadaan sekarang); yang hidup di sana hanya
`get_routing_regions/_cabangs/_areas`. Daftar ini tetap otoritatif untuk project baru.

```
get_my_profile(p_user_id)                     get_routing_regions()
get_stores_by_area(p_area_id, p_caller_id)    get_routing_cabangs(p_region_id)
get_plans_by_area(p_area_id)                  get_routing_areas(p_cabang_id)
get_plan_assignments(p_plan_id)               get_plan_coverage_summary(p_plan_id)
save_plan(...)         → atomic plan + assignments
next_plan_version(p_area_id)                  approve_plan(p_plan_id, p_user_id)
discard_plan(p_plan_id)
stage_stores(...)      commit_staging(...)     discard_staging(...)
upsert_stores(...)     preview_geocode_summary(...)    update_gadm_for_area(...)
import_gadm_batch(...) truncate_gadm_regions()
import_admin_regions_batch(...)   ← 0007, COD-AB
```

`get_stores_by_area` mengembalikan: `customer_code, customer_name, lat, lon, div_sls,
visit_frequency, omset`. Parameter `p_caller_id uuid DEFAULT NULL` ditambahkan `0005` —
default berarti pemanggil browser tak perlu diubah; hanya 3 call-site `api.py` mengirimnya.

⚠️ **`upsert_stores` & `preview_geocode_summary` adalah orphan** — tak ada pemanggil aktif.
Sengaja dipertahankan `service_role` saja, bukan dihapus.

---

## Dev Commands
```bash
# Frontend
npm run dev

# Engine (dari root project)
python start_engine.py

# TypeScript check
npx tsc --noEmit --strict

# Python syntax check
python -c "import ast; ast.parse(open('api.py').read()); print('syntax OK')"
```

```bash
# Tests — engine (algoritma partisi/jadwal/contiguity, murni lokal, tanpa DB) → 41 lulus
cd route_engine && python -m pytest tests/ -v
```

```bash
# Tests — Path A + visit_frequency (murni lokal) → 14 + 19 lulus
python -m pytest tests/test_path_a.py tests/test_visit_frequency.py -v
```

```bash
# Tests — otorisasi RPC (integrasi ke DB live, rollback, nol tulis)
# ⚠️ 33/36 GAGAL sejak 2026-08-05 — RPC-nya sudah dihapus dari DB bersama.
# Ini benar & informatif, BUKAN regresi kode. Akan hijau lagi di project baru.
python -m pytest tests/test_rpc_authz.py -v
```

```bash
# Replay migrasi ke DB LOKAL (Docker) — WAJIB sebelum menyentuh DB sungguhan.
# Env var SUPABASE_DB_URL didahulukan atas .env.local, jadi runner tak pernah
# membaca kredensial prod saat diarahkan ke lokal.
docker run -d --name jks-pg -p 55441:5432 -e POSTGRES_PASSWORD=postgres postgis/postgis:15-3.4
export SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:55441/postgres

# 1) shim dependensi milik Heroes (auth/mst_hr/mst_area) — psql TIDAK terpasang
#    di mesin ini, jadi lewat psycopg2:
python -c "import os,psycopg2; c=psycopg2.connect(os.environ['SUPABASE_DB_URL']); c.autocommit=True; c.cursor().execute(open('scripts/local-dev/shim_external_deps.sql',encoding='utf-8').read()); print('shim OK')"

# 2) bootstrap ledger — runner MENOLAK jalan kalau jks_engine._migrations belum ada
#    (chicken-and-egg: ledger dibuat oleh 0002, tapi runner butuh ledger dulu)
python -c "import os,psycopg2; c=psycopg2.connect(os.environ['SUPABASE_DB_URL']); c.autocommit=True; c.cursor().execute(open('supabase/migrations/0002_migrations_ledger.sql',encoding='utf-8').read()); print('ledger OK')"

# 3) apply migrasi (baca dry-run dulu; berhenti di file pertama yang gagal)
python scripts/run_migrations.py --dry-run && python scripts/run_migrations.py

# 4) isi admin_regions dgn COD-AB nyata (butuh file .gdb COD-AB)
python scripts/local-dev/seed_admin_regions_local.py <path>/idn_admin_boundaries.gdb
```

```bash
# Cek migrasi pending sebelum apply ke DB mana pun
python scripts/run_migrations.py --dry-run
```

---

## Pending / Next Session

> Rencana produk ada di **`docs/VISI.md`**. `docs/ROADMAP.md` masih menggambarkan tool
> internal dan usang sebagian. Jangan duplikasi keduanya di sini.

### Blocker tunggal: provisioning project Supabase baru

Semua pekerjaan lain menunggu ini, karena tanpa DB tak ada aplikasi. Yang sudah siap:

- [x] **Rantai migrasi `0001`–`0010` terbukti replay bersih dari nol** + lulus uji fungsional
      end-to-end (upload toko → geocode COD-AB → simpan → baca balik, guard C1, ACL anon) di
      Postgres+PostGIS Docker lokal. Commit `62b6ce6`. Lima bug nyata ketemu di situ, yang
      **tak akan pernah ketahuan tanpa replay sungguhan**:
      (1) `CREATE SEQUENCE` hilang di baseline · (2) urutan FK terbalik (dump urut alfabet,
      bukan urut dependensi) · (3) `UPDATE … FROM LATERAL` merujuk alias target — tak valid ·
      (4) **18 dari 20 RPC akan lahir terbuka ke `anon`** di project baru, karena selama ini
      yang melindungi mereka adalah sapuan keamanan milik Heroes (migrasi `0297` mereka),
      bukan migrasi JKS sendiri → ditutup `0010` · (5) shim `slot_assignment_flat` kurang
      lengkap (3 kolom vs 27).
- [x] **COD-AB gantikan GADM** (`0007` + `0008` + `scripts/import_codab.py`). Bukan kosmetik:
      lisensi GADM melarang penggunaan komersial → **blocker legal** untuk platform publik.
      COD-AB = data BPS dikurasi OCHA, CC BY 3.0 IGO (komersial boleh, kewajiban hanya
      atribusi), dan lebih lengkap (7.069 kecamatan vs 6.695; 81.912 desa vs 77.473).
      Bonus teknis: `adm4_pcode` = kode BPS → bisa di-JOIN ke statistik BPS lain lewat kode,
      bukan pencocokan nama.
- [x] **Fix `visit_frequency`** (`0009` + `api.py`) — menghentikan default senyap. 19 test.
- [ ] **Buat project Supabase baru + identitas sendiri.** `get_my_profile` lama bersandar pada
      `mst_hr.slot_assignment_flat` milik Heroes, yang mereka rombak besar sepanjang Agustus
      (`slot_flat` → `slot_row`). Jalur lama **tidak bisa dipulihkan apa adanya** — auth harus
      dibangun ulang. Konsekuensi: `scripts/local-dev/shim_external_deps.sql` bukan sekadar
      alat tes, ia peta dari apa yang harus digantikan sungguhan (`auth`, `mst_hr`, `mst_area`).
- [ ] **Migrasi data**: 22.674 toko + 24 plan + 20.537 assignment masih utuh di DB lama dan
      perlu diekspor sebelum ada yang menjalankan `DROP SCHEMA jks_engine CASCADE` (Heroes
      menyebutnya sebagai keputusan terpisah, belum diambil — jangan diandalkan tetap begitu).
- [ ] **Keputusan terbuka:** apakah cangkang ditulis ulang sekalian saat pindah (VISI §2:
      `route_engine/` ~15% selamat utuh, ~85% cangkang ditulis ulang) atau cangkang lama
      di-porting dulu supaya ada yang jalan? Ini keputusan user, bukan teknis.

### Utang yang tetap terbuka (tidak hilang karena pindah DB)

- [ ] **Otorisasi masih biner.** Guard hanya cek keanggotaan `jks_engine.access_roles`,
      **bukan scope area** → C1 versi asli (akses lintas-area) **belum tertutup**. Dan 6 RPC
      baca lain tanpa guard sama sekali (`get_plans_by_area`, `get_plan_assignments`,
      `get_routing_*`, `next_plan_version`). Di DB bersama artinya ~1300 akun Heroes; di
      platform multi-tenant artinya **kebocoran lintas-pelanggan** — VISI §9 menaikkannya
      jadi "struktural dan teruji".
- [ ] **Fail-loud FE** — `AreaContext.tsx:52`, `RoutingEnginePage.tsx:1606`,
      `DashboardPage.tsx:239`, `PlanMapPage.tsx:500` tak memeriksa `error` → RPC gagal tampil
      sebagai empty-state yang tampak sah ("0 toko", "Upload data toko terlebih dahulu" untuk
      1500+ toko yang ada). Doktrin "crash terlihat > menyimpang senyap" yang sudah ditegakkan
      di engine **berhenti di batas Python**. VISI §9: di onboarding self-serve ini
      **mematikan** — pelanggan hilang tanpa jejak.
- [ ] **`visit_frequency` rusak di produksi** — kolom `text` berisi `'1'` untuk semua 22.674
      toko → semua jatuh ke BIWEEKLY → **20.537 assignment dijadwalkan separuh frekuensi**,
      termasuk **2 plan APPROVED**. Fix kode & SQL sudah ada (`0009`), **belum diterapkan ke
      DB mana pun**. Ditunda sadar (perombakan cadence menyusul) — verifikasi menunjukkan
      hanya memengaruhi flag ganjil/genap; penempatan sales & hari tidak berubah.
      ⚠️ **Naik jadi prasyarat** begitu headcount diturunkan dari beban (VISI §5, §9).
      Detail: `docs/pilot/README.md` §6.
- [ ] **H1 — `ROUTE_ENGINE_SECRET` belum divalidasi.** ⚠️ Pengirimnya (Edge Function) = jalur
      mati; browser memanggil FastAPI langsung, jadi shared-secret **tak cocok** untuk jalur
      nyata (rahasianya harus dikirim ke browser). **Pertimbangkan ulang bentuknya**, jangan
      salin resep lama.
- [ ] **H2/M1–M4/M6–M8** dari `AUDIT.md` — CORS prod-safe, batas input (`max_items`, bound
      lat/lon), pin `requirements-api.txt`, `python-dotenv` eksplisit, model lock TRAFFIC,
      race double-click. Hilang dari ROADMAP, belum dikerjakan.
- [ ] **`0001_baseline.sql` bisa drift lagi** kapan pun ada perubahan out-of-band di prod —
      pola `slot_assignment_flat.auth_user_id` & `dim_slots.R00-00-02.scope` membuktikannya.
      Kurang relevan setelah pindah ke project sendiri, tapi jangan diperlakukan sebagai
      kebenaran abadi selama masih dipakai sebagai sumber.

### Sudah SELESAI — jangan dikerjakan ulang

- [x] Deploy engine → Cloud Run 1-container deploy-dari-git (⚠️ menunjuk DB yang kini mati)
- [x] Tahap 3 adjustment (editor hari/pekan `s2_preview` + undo/redo, sadar-filosofi
      TRAFFIC/BLOCKING, terbukti persist via plan V6)
- [x] Hasil plan di peta (`PlanMapPage` warnai circleMarker per sales) + tab Wilayah
- [x] Dashboard metric cards dari data nyata, bukan placeholder
- [x] Baseline migrasi + runner + ledger `jks_engine._migrations`
- [x] C1 jalur tulis & baca (`0003`–`0005`, 7 RPC, test-first) + kebocoran `anon` (`0006`)
- [x] AUDIT M5 — `ROUTE_LENGTH` ditolak eksplisit di dua gerbang
- [x] Path A menjalankan QC + summary
- [x] Contiguity teritori diukur & dilaporkan
- [x] Paket tes distributor kedua (`docs/pilot/`, `scripts/pilot_run.py`) — siap, **sengaja
      ditunda**: ia menguji komponen lama, bukan proposisi baru di `VISI.md`
