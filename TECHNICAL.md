# JKS Route Engine v2 — Dokumentasi Teknis

> Versi dokumen: 2026-06-05 (Sesi 8)

---

## Daftar Isi

1. [Gambaran Sistem](#1-gambaran-sistem)
2. [Arsitektur](#2-arsitektur)
3. [Struktur Direktori](#3-struktur-direktori)
4. [Frontend (React)](#4-frontend-react)
5. [Python Engine (FastAPI)](#5-python-engine-fastapi)
6. [Database (Supabase)](#6-database-supabase)
7. [Algoritma Routing](#7-algoritma-routing)
8. [Alur Fitur Adjustment](#8-alur-fitur-adjustment)
9. [Setup Dev](#9-setup-dev)
10. [Deployment Produksi](#10-deployment-produksi)
11. [Known Limitations](#11-known-limitations)

---

## 1. Gambaran Sistem

JKS Route Engine v2 adalah aplikasi SFA (Sales Force Automation) untuk menghasilkan
**rencana kunjungan optimal** (route plan) bagi salesman distributor FMCG.

**Masalah yang diselesaikan:**
- Distribusi toko ke salesman secara merata (wilayah + jumlah)
- Penjadwalan hari kunjungan agar efisien secara geografis
- Siklus M1 (mingguan) atau M2 (2 minggu — ganjil/genap bergantian)
- Multi-divisi dalam satu area (AEGDA, AEPDA, TX2DA, dll.)

**Pengguna:**
- Manajer distribusi → generate + approve plan
- Admin sistem → upload data toko, manage area

---

## 2. Arsitektur

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ DashboardPage│  │ RoutingEngine│  │ PlansPage / PlanMap  │   │
│  │             │  │ Page         │  │                      │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                │                      │               │
│         └────────────────┼──────────────────────┘               │
│                          │                                       │
│              Supabase JS Client (anon key)                       │
└──────────────────────────┼──────────────────────────────────────┘
                           │
              ┌────────────┴─────────────┐
              │                          │
              ▼                          ▼
  ┌─────────────────────┐    ┌──────────────────────┐
  │  Supabase (Postgres)│    │  Python FastAPI        │
  │  - Auth             │    │  api.py (ROOT)         │
  │  - RPC (SECURITY    │    │  port 8000             │
  │    DEFINER)         │    │                        │
  │  - jks_engine.*     │◄───│  - /stage1             │
  │  - public.*         │    │  - /stage2             │
  └─────────────────────┘    │  - /generate-plan      │
                             │  - /health             │
                             └──────────────────────┘
```

**Catatan:** Frontend memanggil Python engine LANGSUNG (bukan via Edge Function).
Edge Function di `supabase/functions/generate-plan/` adalah jalur alternatif
yang belum dipakai di production.

---

## 3. Struktur Direktori

```
jks-v2/
├── api.py                          # FastAPI entry point (ROOT — wajib di sini)
├── start_engine.py                 # Dev startup (load .env.local + uvicorn)
├── CLAUDE.md                       # AI coding hints
├── TECHNICAL.md                    # Dokumen ini
│
├── src/                            # React frontend
│   ├── main.tsx
│   ├── App.tsx                     # Router + AuthProvider + PrivateRoute
│   ├── lib/
│   │   └── supabase.ts             # Supabase client singleton
│   ├── context/
│   │   ├── AuthContext.tsx         # useAuth — user, login, logout
│   │   └── AreaContext.tsx         # useArea — Region→Cabang→Area cascade
│   ├── components/layout/
│   │   ├── AppShell.tsx            # Sidebar nav + header + routes
│   │   └── AreaPicker.tsx          # Dropdown / card variant
│   └── pages/
│       ├── LoginPage.tsx
│       ├── DashboardPage.tsx       # Metrics + peta + plan list
│       ├── RoutingEnginePage.tsx   # Peta + panel kiri + panel kanan + adjustment
│       ├── PlansPage.tsx           # Daftar plan, approve, discard
│       ├── PlanMapPage.tsx         # Review plan di peta (read-only)
│       └── UploadTokoPage.tsx      # Staging upload toko
│
├── route_engine/                   # Python engine package
│   ├── api.py                      # Stub — re-export dari root api.py
│   ├── engine.py                   # RouteEngine class (orchestrator)
│   ├── models.py                   # Store, PlanConfig, Assignment, enums
│   ├── constants.py                # day_name, dll.
│   ├── Dockerfile                  # Docker image untuk VPS
│   ├── requirements.txt            # scipy, numpy, dll.
│   ├── requirements-api.txt        # fastapi, uvicorn, supabase, dll.
│   ├── core/
│   │   ├── partition.py            # balanced_partition (K-Means)
│   │   ├── scheduling.py           # slice_by_bearing, build_blocking, build_traffic
│   │   ├── biweekly.py             # split_ganjil_genap (M2)
│   │   ├── estimator.py            # nn_tour (nearest-neighbor sequencing)
│   │   ├── geo.py                  # bearing, centroid, haversine
│   │   ├── qc.py                   # QC flag koordinat
│   │   └── summary.py              # build_summary
│   └── tests/
│       ├── test_acceptance.py      # End-to-end acceptance tests
│       └── test_geo.py
│
├── supabase/
│   └── functions/
│       └── generate-plan/
│           └── index.ts            # Edge Function (jalur alternatif)
│
├── scripts/
│   └── import_gadm.py              # Import data GADM untuk geocoding
│
├── package.json
├── vite.config.ts
├── tsconfig.app.json
└── .env                            # VITE_ public vars (aman di-commit)
```

---

## 4. Frontend (React)

### 4.1 Context Providers

**AuthContext** (`src/context/AuthContext.tsx`)
- State: `user: UserProfile | null`, `loading: boolean`
- Login: `supabase.auth.signInWithPassword` → `get_my_profile` RPC
- Restore session: `onAuthStateChange` handle `INITIAL_SESSION` (1x fetchProfile, bukan 3x)
- `UserProfile` berisi: `nik`, `full_name`, `role_name`, `scope_id`, `branch_code`, dll.

**AreaContext** (`src/context/AreaContext.tsx`)
- Cascade state: Region → Cabang → Area
- `activeArea: ActiveArea | null` — dibagikan ke semua halaman
- Data dimuat via RPCs: `get_routing_regions`, `get_routing_cabangs`, `get_routing_areas`

### 4.2 Halaman

| Route | Komponen | Status |
|-------|----------|--------|
| `/` | DashboardPage | ✅ |
| `/routing` | RoutingEnginePage | ✅ |
| `/plans` | PlansPage | ✅ |
| `/plans/:planId/map` | PlanMapPage | ✅ (read-only) |
| `/upload` | UploadTokoPage | ✅ |
| `/login` | LoginPage | ✅ |

### 4.3 RoutingEnginePage — State Machine

```
DivisionState per divisi:
  idle
    ↓ [Bagi Wilayah]
  s1_running
    ↓
  s1_done          ← territories ada, jadwal belum
    ↓ [Generate Jadwal]
  s2_running
    ↓
  s2_preview       ← territories + schedule tersedia
    ↓ [Simpan Plan]
  s2_saving
    ↓
  s2_done          ← plan tersimpan di DB
```

**State utama:**
```typescript
divisionStates: Map<string, DivisionState>  // key = div_sls
selectedStore: SelectedStore | null          // single-click popup
multiSelected: Set<string>                   // ctrl+click multi-select
selectedSales: SelectedSales | null          // panel kanan filter
```

### 4.4 Komponen Peta (PlanMap)

- Leaflet diinisialisasi SEKALI dalam `useEffect([], [])` — tidak rebuild
- `onClickRef` pattern: callback yang bisa berubah tanpa rebuild markers
- `selectedCodes`: toko yang Ctrl+diklik → warna amber, radius lebih besar
- Menutup popup saat map pan/zoom via `onMapInteract` callback

### 4.5 Fitur Adjustment (Tahap 1 & 2 — BLOCKING)

**Tahap 1 — Store Info Popup:**
- Klik toko → floating card muncul DI ATAS marker (bukan pojok)
- Posisi: `left: pos.x, transform: translate(-50%, -100%)` + 14px offset
- Auto-flip ke bawah jika marker terlalu dekat tepi atas (pos.y < 230)
- Menampilkan: nama toko, kode, divisi, salesperson saat ini, omset

**Tahap 2 — Reassign Sales:**
- Hanya aktif di state `s1_done`
- Tombol reassign di popup → `handleReassign` → update `territories` in-memory
- Ctrl+Click → `multiSelected` Set → `MultiSelectBar` muncul di bawah peta
  - Menampilkan: jumlah toko, total omset, tombol target territory
  - Reassign sekaligus → `handleMultiReassign`

**Tahap 3 — Ganti Hari + Minggu (BELUM DIIMPLEMENTASI):**
- Di state `s2_preview`
- Klik toko → pilih hari baru + minggu (ganjil/genap untuk M2)

---

## 5. Python Engine (FastAPI)

### 5.1 Endpoints

| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| `POST` | `/stage1` | JWT | K-Means partisi sales, return territories |
| `POST` | `/stage2` | JWT | Penjadwalan hari dari territories, return schedule |
| `POST` | `/generate-plan` | JWT | Stage 1+2 atau locked territories → save ke DB |
| `GET` | `/health` | — | Health check |

### 5.2 /stage1

**Request:**
```json
{
  "area_id": "uuid",
  "kd_dist": "1000596",
  "depo_lat": -6.123,
  "depo_lon": 106.456,
  "divisions": [
    {"div_sls": "TX2DA", "n_sales": 5, "balance_tolerance": 0.10}
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "div_sls": "TX2DA",
      "territories": [
        {
          "sales_index": 0,
          "sales_name": "1000596-TX2DA-01",
          "store_count": 82,
          "centroid_lat": -6.12,
          "centroid_lon": 106.45,
          "customer_codes": ["A001", "A002", ...]
        }
      ]
    }
  ]
}
```

### 5.3 /stage2

**Request:**
```json
{
  "area_id": "uuid",
  "kd_dist": "1000596",
  "depo_lat": -6.123,
  "depo_lon": 106.456,
  "division": {"div_sls": "TX2DA", "work_days": 6, "cycle": "M1", "philosophy": "BLOCKING"},
  "territories": [
    {"sales_index": 0, "sales_name": "1000596-TX2DA-01", "customer_codes": ["A001", ...]}
  ]
}
```

**Response:** `Stage2Response` dengan `territories` + `schedule` (per sales per hari).

### 5.4 /generate-plan

**Dua path:**
- **Path A** (`div.territories != null`): skip K-Means, langsung `_build_from_territories()`
- **Path B** (`div.territories == null`): jalankan `engine.run()` dengan K-Means

`_build_from_territories()` adalah shared helper antara `/stage2` dan `/generate-plan`:
1. Per territory, ambil Store objects dari store_map
2. `centroid()` wilayah → center untuk `slice_by_bearing`
3. `slice_by_bearing(stores, center, work_days)` → day assignments
4. `nn_tour()` per blok (sales, hari) → urutan optimal
5. `split_ganjil_genap()` jika M2

### 5.5 Auth di FastAPI

JWT dari frontend dikirim via `Authorization: Bearer <token>`.
Diverifikasi menggunakan Supabase `auth.get_user(token)` — tidak perlu `SUPABASE_JWT_SECRET`.
Menggunakan service-role client (`SUPABASE_SERVICE_KEY`) untuk akses DB.

---

## 6. Database (Supabase)

### 6.1 Schema

```
public.*         — data master (regions, branches, areas, users)
jks_engine.*     — engine data (stores, plans, assignments, staging)
```

**Tabel utama:**
```sql
jks_engine.stores            -- data toko (customer_code, lat, lon, div_sls, omset, ...)
jks_engine.stores_staging    -- staging upload sebelum commit
jks_engine.plans             -- plan header (plan_name, status, divisions JSONB, ...)
jks_engine.plan_assignments  -- assignment per toko (sales_person_name, day_index, ...)
```

### 6.2 Akses Control (RLS + Schema Grant)

⚠️ **Gotcha kritis:** `authenticated` role TIDAK punya `USAGE` grant pada schema `jks_engine`.
Query langsung dari client (`supabase.from('jks_engine.stores')`) akan GAGAL.

Semua akses data dari frontend harus melalui RPC dengan `SECURITY DEFINER`.

### 6.3 RPC Lengkap

```sql
-- Auth
get_my_profile(p_user_id uuid)

-- Area hierarchy
get_routing_regions()
get_routing_cabangs(p_region_id uuid)
get_routing_areas(p_cabang_id uuid)

-- Stores
get_stores_by_area(p_area_id uuid)
  → customer_code, customer_name, latitude, longitude,
    div_sls, visit_frequency, omset

-- Staging
stage_stores(p_area_id, p_stores jsonb)
commit_staging(p_area_id)
discard_staging(p_area_id)

-- Plans
save_plan(p_plan_id, p_area_id, p_plan_name, p_divisions,
          p_version_ids, p_summary, p_created_by, p_assignments)
next_plan_version(p_area_id) → int
get_plans_by_area(p_area_id)
get_plan_assignments(p_plan_id)
approve_plan(p_plan_id, p_user_id)
discard_plan(p_plan_id)
```

### 6.4 GADM Geocoding

Data polygon wilayah dari GADM diimpor ke `gadm_regions`.
- Toleransi simplifikasi: 0.001° (~100m) — cukup akurat tanpa celah antar polygon
- KNN fallback: jika `ST_Within` gagal, cari K tetangga terdekat (0.01°)
- Kolom: `gid_0`–`gid_4`, `type_4`, geometry
- Wajib `ANALYZE gadm_regions` setelah reimport

---

## 7. Algoritma Routing

### 7.1 BLOCKING Philosophy (Sales-First)

```
Semua toko area
      ↓
[K-Means balanced_partition] → N sales
  (toleransi ±10%, fallback slice_by_bearing jika K-Means gagal)
      ↓
Per sales: [slice_by_bearing dari centroid wilayah sales]
  → work_days irisan pie
      ↓
Per blok (sales, hari): [nn_tour] → urutan kunjungan
      ↓
Jika M2: [split_ganjil_genap] → toko ganjil vs genap
```

### 7.2 TRAFFIC Philosophy (Day-First)

```
Semua toko area
      ↓
[slice_by_bearing dari depo] → work_days hari global
      ↓
Per hari: [balanced_partition] → N sales
      ↓
Per blok (sales, hari): [nn_tour] + [split_ganjil_genap]
```

### 7.3 slice_by_bearing

Algoritma kunci untuk jaminan hari berurutan melingkar:
1. Hitung bearing (0°–360°) tiap toko dari center
2. Sort by (bearing, customer_code) — deterministik
3. Potong N irisan equal-count → irisan berurutan melingkar by construction

### 7.4 balanced_partition

1. KMeans(n_clusters=n_sales, random_state=42) dari koordinat
2. Cek toleransi kerataan: `max_count / avg_count ≤ 1 + tolerance`
3. Jika tidak merata: fallback ke `slice_by_bearing` dari depo

### 7.5 M2 Biweekly Split (split_ganjil_genap)

Toko dalam satu blok (sales, hari) dibagi dua berdasarkan urutan nn_tour:
- Posisi ganjil (1, 3, 5...) → M2C13 (minggu 1 & 3)
- Posisi genap (2, 4, 6...) → M2C24 (minggu 2 & 4)

Deterministik: tergantung urutan nn_tour, bukan random.

### 7.6 Determinisme

Seluruh pipeline deterministik:
- `random_state=42` di K-Means
- Sort by `customer_code` sebelum setiap operasi (tie-break stabil)
- Input sama → output identik byte-per-byte

---

## 8. Alur Fitur Adjustment

### 8.1 Alur Lengkap (BLOCKING)

```
[Stage 1: Bagi Wilayah]
  → state: s1_done
  → territories: [{sales_name, customer_codes, ...}]

[Tahap 2: Reassign — opsional]
  Klik toko → popup → pilih target sales
  ATAU Ctrl+klik banyak toko → MultiSelectBar → pindah semua
  → update territories in-memory (stage tetap s1_done)

[Stage 2: Generate Jadwal]
  → /stage2 dengan territories yang mungkin sudah diedit
  → state: s2_preview
  → schedule: [{sales_name, days: [{day_of_week, customer_codes, ...}]}]

[Tahap 3: Ganti Hari (TODO)]
  Di s2_preview: klik toko → pilih hari baru + minggu
  → update schedule in-memory

[Simpan Plan]
  → /generate-plan dengan territories (Path A — skip K-Means)
  → state: s2_done
  → plan tersimpan di DB
```

### 8.2 Koordinat Popup

Popup muncul tepat di atas marker menggunakan pixel coordinates dari Leaflet:
```typescript
.on('click', (e) => {
  pos = { x: e.containerPoint.x, y: e.containerPoint.y }
  // Posisi CSS: left: pos.x, transform: translate(-50%, calc(-100% - 14px))
})
```

Auto-flip jika marker dekat tepi atas (pos.y < 230px).

---

## 9. Setup Dev

### Prerequisites
- Node.js 20+
- Python 3.11+
- `pip install fastapi uvicorn supabase scipy numpy python-dotenv`

### Frontend

```bash
npm install
npm run dev
# → http://localhost:5173
```

**Env vars** (`.env`):
```
VITE_SUPABASE_URL=https://zxrurtmjpaifzjrqcayb.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_ENGINE_URL=http://localhost:8000
```

### Python Engine

```bash
# Dari root project directory
python start_engine.py
# → http://localhost:8000
# → http://localhost:8000/docs (Swagger UI)
```

**Env vars** (`.env.local`):
```
SUPABASE_URL=https://zxrurtmjpaifzjrqcayb.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

`start_engine.py` secara otomatis memetakan:
- `NEXT_PUBLIC_SUPABASE_URL` → `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY`

### Tests

```bash
python -m pytest route_engine/tests/ -v
```

---

## 10. Deployment Produksi

### Docker Build

Dari root project:
```bash
docker build -f route_engine/Dockerfile -t jks-engine:latest .
```

### Docker Run

```bash
docker run -d \
  -p 8000:8000 \
  -e SUPABASE_URL=https://... \
  -e SUPABASE_SERVICE_KEY=<service_role_key> \
  -e ALLOWED_ORIGINS=https://your-app.vercel.app \
  --name jks-engine \
  jks-engine:latest
```

### Env Vars Production

| Nama | Wajib | Keterangan |
|------|-------|-----------|
| `SUPABASE_URL` | ✅ | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | ✅ | Service role key (Settings > API) |
| `ALLOWED_ORIGINS` | ❌ | Comma-separated, default: localhost |

### Frontend (Vercel/Netlify)

```
VITE_SUPABASE_URL=https://...
VITE_SUPABASE_ANON_KEY=...
VITE_ENGINE_URL=https://engine.your-vps.com
```

### Supabase Edge Function (jalur alternatif)

```bash
supabase functions deploy generate-plan
supabase secrets set ROUTE_ENGINE_URL=https://engine.your-vps.com
supabase secrets set ROUTE_ENGINE_SECRET=<shared-secret>
```

---

## 11. Known Limitations

### Engine
- `balanced_partition` hanya pakai `BalanceCriterion.COUNT` (jumlah toko).
  `ROUTE_LENGTH` (estimasi panjang rute) belum diimplementasikan.
- TRAFFIC philosophy belum ada UI adjustment (hanya BLOCKING).
- `tier` field di Store model belum ada data nyata.

### Frontend
- Tahap 3 adjustment (Ganti Hari + Minggu di `s2_preview`) belum diimplementasikan.
- `/plans/:planId/map` belum punya fitur adjustment (hanya read-only).
- Dashboard "Live Monitoring" map belum menampilkan toko dari assignment aktif.
- RPCs `approve_plan` dan `discard_plan` dipanggil di PlansPage — belum diverifikasi
  apakah sudah ada di DB.

### Infrastructure
- Edge Function (`supabase/functions/generate-plan/`) belum dipakai — kontrak API-nya
  berbeda dari `api.py` yang dipakai frontend saat ini.
- Engine belum di-deploy ke VPS.

### Security
- `ROUTE_ENGINE_SECRET` di Edge Function belum diimplementasikan di `api.py`
  (saat ini hanya verifikasi JWT user Supabase).

---

*Generated by Claude Code — sesi 8, 2026-06-05*
