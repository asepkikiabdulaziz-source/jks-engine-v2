# JKS Route Engine v2 — Claude Code Context

## Project Root
`D:\PROJECT\jks-v2`

## Stack Cepat
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + Leaflet
- **Backend**: Python 3.11 FastAPI (`api.py` di root, bukan di `route_engine/`)
- **DB**: Supabase (PostgreSQL) — semua akses client via RPC SECURITY DEFINER
- **Auth**: Supabase Auth — JWT diverifikasi di FastAPI via `db.auth.get_user(token)`

## Peta dokumen (baca sesuai kebutuhan)

| Dokumen | Isi |
|---|---|
| `docs/ROADMAP.md` | **Rencana kerja — sumber kebenaran.** Item A–F, effort, keputusan terbuka |
| `docs/incident-2026-07-17/` | Insiden login mati: root cause, SQL perbaikan, briefing utk nabati-heroes |
| `AUDIT.md` | Audit keamanan 2026-06-06 (C1/H1 masih terbuka) |
| `TECHNICAL.md` | Arsitektur detail: FE, engine, endpoint, schema (⚠️ tanpa DDL) |

## Aturan Kritis

### 0. ⚠️ DB ini BUKAN milik kita — JKS MENUMPANG

Supabase `zxrurtmjpaifzjrqcayb` dimiliki & dikelola aktif oleh project **nabati-heroes**
(`D:\PROJECT\nabati-heroes` — 392+ migrasi, commit harian, ~82 user aktif). JKS numpang.
**Coupling DUA ARAH** — fitur peta DWM mereka membaca `jks_engine.gadm_regions` + `jks_engine.stores`
(migrasi 0279-0284), jadi "pisahkan DB" bukan langkah gratis.

Konsekuensi nyata (2026-07-17: **login JKS mati total**, insiden panjang — baca sebelum menyimpulkan):
- `auth.users`, `mst_hr`, dan RPC di schema `public` adalah **permukaan bersama**. Perubahan sah
  di sisi mereka bisa menjatuhkan JKS **tanpa jejak apa pun di repo ini** — ini prinsip yang tetap
  benar, terlepas dari akar masalah insiden 07-17 di bawah.
- Insiden 07-17: ditemukan bug nyata di `custom_access_token_hook` **milik mereka** (`jsonb_set`
  STRICT + `scope=NULL` di slot admin JKS → hook return NULL) — **tapi koreksi penting**: Dashboard
  Auth Hooks mereka **kosong**, hook itu tak pernah benar-benar terpasang di GoTrue. Root cause
  sebenarnya: **password admin JKS yang usang**. Bug hook tetap valid & sudah diperbaiki (berguna
  kalau hook diaktifkan kelak), tapi bukan penyebab literal insiden. Detail lengkap + kronologi
  penuh: `docs/incident-2026-07-17/README.md`. **Pelajarannya tetap berlaku:** kalau login gagal,
  **jangan buru-buru simpulkan mekanismenya** — verifikasi tiap lapis (password, hook, grant,
  guard) sebelum menuduh satu penyebab.
- Slot login JKS = `mst_hr.dim_slots.R00-00-02` (ADMIN Heroes lama; sekarang `job_title='000004'`
  EXTERNAL_JKS, `scope='00'`).
- **Repo ini kini punya migrasi SQL** — `supabase/migrations/0001_baseline.sql` (dump skema
  `jks_engine`+17 RPC via `scripts/dump_baseline.py`, `pg_dump` tak tersedia di mesin ini) +
  `scripts/run_migrations.py` + ledger `jks_engine._migrations`. `SUPABASE_DB_URL` ada di
  `.env.local` (pooler) → `psycopg2` terpasang, `psql` tidak.

### 1. Akses DB dari Frontend — selalu via RPC
Tabel di `jks_engine` schema **tidak bisa** di-query langsung dari client karena
`authenticated` role tidak punya `USAGE` grant pada schema tersebut.
Selalu gunakan RPC dengan `SECURITY DEFINER`:
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
Dev server: `python start_engine.py` (load .env.local otomatis)

### 3. Leaflet + React — pola useRef wajib
Jangan pernah rebuild Leaflet map di setiap render.
Gunakan `useRef` untuk map + layer, `useEffect` dengan `[]` dependency untuk init.
Untuk callback (onClick etc.) gunakan `onClickRef` pattern agar tidak stale closure.

### 4. DivStage state machine
```
idle → s1_running → s1_done → s2_running → s2_preview → s2_saving → s2_done
```
- `s1_done`: territories ada, jadwal belum → bisa reassign toko antar sales (Tahap 2)
- `s2_preview`: jadwal ada → bisa lihat schedule + save

### 5. Engine — dua jalur di /generate-plan
- **Path A** (`div.territories != null`): skip K-Means, pakai territories yang sudah ditetapkan
- **Path B** (`div.territories == null`): jalankan K-Means baru

### 6. Sales name format
Format: `{kd_dist}-{div_sls}-{nomor:02d}` → contoh: `1000596-TX2DA-01`
Display: `salesLabel()` di RoutingEnginePage → `TX2DA-SLS-01`

## File Penting
| File | Keterangan |
|------|-----------|
| `api.py` | FastAPI entry point (ROOT) |
| `route_engine/engine.py` | RouteEngine class — `partition_sales()` + `run()` |
| `route_engine/core/scheduling.py` | `build_blocking`, `build_traffic` (penempatan hari murni K-Means) |
| `route_engine/core/partition.py` | `balanced_partition` (KMeansConstrained, fail-loud) |
| `supabase/migrations/` | Baseline + ledger — jalankan `python scripts/run_migrations.py --dry-run` sebelum ubah skema |
| `src/pages/RoutingEnginePage.tsx` | Halaman utama — peta + panel + adjustment |
| `src/context/AreaContext.tsx` | State area aktif (Region → Cabang → Area) |
| `supabase/functions/generate-plan/index.ts` | Edge Function (path alternatif, belum dipakai) |

## RPC yang Ada di DB
```
get_my_profile(p_user_id)
get_routing_regions()
get_routing_cabangs(p_region_id)
get_routing_areas(p_cabang_id)
get_stores_by_area(p_area_id)    → returns: customer_code, customer_name, lat, lon, div_sls, visit_frequency, omset
get_plans_by_area(p_area_id)
get_plan_assignments(p_plan_id)
save_plan(...)                   → atomic save plan + assignments
next_plan_version(p_area_id)
approve_plan(p_plan_id, p_user_id)
discard_plan(p_plan_id)
stage_stores(...)
commit_staging(...)
discard_staging(...)
```

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

# Tests — engine (algoritma partisi/jadwal, murni lokal, tanpa DB)
cd route_engine && python -m pytest tests/ -v

# Tests — otorisasi RPC (integrasi ke DB live, butuh SUPABASE_DB_URL di .env.local)
# Semua dibungkus transaksi rollback -- nol tulis ke prod. pip install -r tests/requirements.txt
python -m pytest tests/ -v
```

## Pending / Next Session

> Rencana lengkap ada di **`docs/ROADMAP.md`** (item A–F + keputusan terbuka). Jangan duplikasi di sini.

**Blocker sekarang:**
- [x] ~~Login JKS mati~~ — **RESOLVED** (2026-07-17). Password direset + diuji end-to-end
      (login→sesi→`get_my_profile`) — SUKSES, tanpa eskalasi hak. `access_roles.'000002'` sudah
      dicabut (2 staf Heroes kehilangan akses JKS, disengaja). ⚠️ **Root-cause literal = password
      usang**, BUKAN bug hook seperti yang awalnya disimpulkan kedua tim (Dashboard Auth Hooks
      mereka kosong — hook tak pernah terpasang). Bug `jsonb_set`/scope NULL tetap nyata & sudah
      diperbaiki, tapi bukan penyebab. ⚠️ fix yang KAMI usulkan awalnya SALAH (akan eskalasi hak).
      Kronologi lengkap: `docs/incident-2026-07-17/README.md`.
- [ ] **Upload Toko mati (gap 0398)** — `commit_staging`+`discard_staging` masih ditolak `authenticated`.
      Heroes sudah menulis migrasi `0401` (fix ini) + `0402` (bug `user_nik`/`survey_*`/`kotak_saran`
      di kode mereka sendiri, ditemukan lewat investigasi kita) — keduanya **siap, menunggu apply
      pemilik** via SQL Editor mereka. Lihat `docs/incident-2026-07-17/ADDENDUM_gap_0398.md`.

**Wajib sebelum trial dibuka luas:**
- [~] **C1 — otorisasi area di `api.py`** — **jalur TULIS ditutup, jalur BACA masih terbuka.** (2026-07-17)
      Guard `auth.uid()`/`COALESCE(auth.uid(),p_created_by)` LIVE di `get_my_profile` + 5 RPC mutasi
      (`approve_plan`/`discard_plan`/`save_plan`/`stage_stores`/`upsert_stores`) — `0003_guard_authz_rpc.sql`
      + `0004_fix_save_plan_service_role_guard.sql` (regresi service_role ditemukan & diperbaiki hari
      yang sama). Diverifikasi HTTP sungguhan: JKS lolos, user Heroes asli (Putri) ditolak `42501` baik
      via browser maupun service_role. `save_plan` (jalur `/generate-plan` dry_run=false) kini aman.
      ⚠️ **`get_stores_by_area` — TIDAK ikut ter-guard, dan MASIH BOCOR.** Dipanggil via service_role
      di `api.py:327,765,829` (`/generate-plan`,`/stage1`,`/stage2`), nol guard di DB (dikonfirmasi:
      `prosrc` tak mengandung "Akses ditolak"). Fungsi ini cuma terima `p_area_id` — beda dari
      `save_plan`, TIDAK punya parameter identitas pemanggil (`p_created_by`) utk fallback, jadi pola
      fix yang sama tak langsung berlaku. User Heroes mana pun (JWT valid dari GoTrue bersama) masih
      bisa `curl` ketiga endpoint itu dan membaca `customer_code`+lat/lon toko area MANA PUN.
      **Perbaikan kemungkinan perlu di level `api.py`** (cek membership stlh `_verify_jwt`, SEBELUM
      panggil `get_stores_by_area`) — bukan migrasi SQL, perlu redeploy. **BELUM dikerjakan.**
- [ ] **H1 — validasi `ROUTE_ENGINE_SECRET`** (catatan: Edge Function pengirimnya = jalur mati; browser
      panggil FastAPI langsung, jadi shared-secret tak cocok utk jalur nyata — pertimbangkan ulang).

**Utang struktural:**
- [x] ~~Baseline migrasi SQL~~ — **SELESAI** (2026-07-17). `pg_dump` tak ada di mesin ini →
      `scripts/dump_baseline.py` (introspeksi `pg_get_functiondef`+`information_schema`, bukan pg_dump)
      → `supabase/migrations/0001_baseline.sql` (tabel `jks_engine` + 18 RPC `public` milik JKS).
      ⚠️ FK `access_roles.job_title_id`→`mst_hr.positions(id)` bikin replay ke DB kosong gagal tanpa
      shim (pola sama dgn `0169_jks_engine_shim_for_replay.sql` milik Heroes) — belum dibuat.
- [x] ~~Runner migrasi~~ — **SELESAI**. `scripts/run_migrations.py` + ledger `jks_engine._migrations`
      (0001 & 0002 tercatat). `python scripts/run_migrations.py --dry-run` → cek pending sebelum apply.
- [ ] **Fail-loud FE** — `AreaContext.tsx:52`, `RoutingEnginePage.tsx:1606`, `DashboardPage.tsx:239`,
      `PlanMapPage.tsx:500` tak cek `error` → RPC gagal tampil sbg empty-state yang tampak sah
      ("0 toko", "Upload data toko terlebih dahulu" utk 1500+ toko yang ada). Doktrin "crash terlihat >
      menyimpang senyap" yang sudah ditegakkan di engine berhenti di batas Python.

**Sudah SELESAI** (jangan dikerjakan ulang — dikoreksi 2026-07-17):
- [x] Deploy engine → Cloud Run 1-container deploy-dari-git
- [x] Tahap 3 adjustment (editor hari/pekan `s2_preview` + undo/redo)
- [x] RPC `approve_plan` + `discard_plan` — **dikonfirmasi ada di DB** via `pg_proc`
- [x] Hasil plan di peta (`PlanMapPage` warnai circleMarker per sales) + tab Wilayah
- [x] Dashboard metric cards — sudah dari data nyata (`stores.length`, `salesAktif`), bukan placeholder
