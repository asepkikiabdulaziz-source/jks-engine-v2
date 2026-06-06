# JKS Route Engine v2 — Claude Code Context

## Project Root
`D:\PROJECT\jks-v2`

## Stack Cepat
- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 + Leaflet
- **Backend**: Python 3.11 FastAPI (`api.py` di root, bukan di `route_engine/`)
- **DB**: Supabase (PostgreSQL) — semua akses client via RPC SECURITY DEFINER
- **Auth**: Supabase Auth — JWT diverifikasi di FastAPI via `db.auth.get_user(token)`

## Aturan Kritis

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

# Tests
cd route_engine && python -m pytest tests/ -v
```

## Pending / Next Session
- [ ] Deploy Python engine ke VPS (Docker)
- [ ] Tahap 3 adjustment: Ganti Hari + Minggu di `s2_preview`
- [ ] Konfirmasi RPC `approve_plan` + `discard_plan` ada di DB
- [ ] `/plans/:planId/map` — adjustment di halaman review plan
- [ ] Dashboard Live Monitoring map — tampilkan toko assignment aktif
