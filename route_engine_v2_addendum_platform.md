# JKS Route Engine v2 — Addendum Platform (Multi-Depot & Job Queue)

> Dokumen ini adalah **tambahan** dari `route_engine_v2_build_spec.md`.
> Baca spec utama dulu sebelum dokumen ini. Semua guardrail di spec utama tetap berlaku.
> Addendum ini mencakup dua hal: (1) arsitektur multi-depot 300 cabang internal, dan (2) async job queue untuk concurrent plan generation.

---

## Konteks Keputusan

300 depo adalah **kantor cabang satu perusahaan** — satu legal entity, satu IT, satu database. Ini bukan multi-tenancy; ini multi-depot dengan role-based access. Implikasinya:

- **Satu Supabase project** — tidak ada isolated schema per depot.
- **Tidak ada data isolation** antar depot — cukup filter `depot_id` per query.
- **RBAC di application layer** (FastAPI middleware) — lebih mudah di-debug dari RLS Supabase untuk stack ini.
- `permissions_router` yang sudah ada di `main.py` adalah fondasi yang dipakai — jangan buat sistem auth paralel.

---

## 1. Perubahan Data Model

### 1.1 Tambahkan `depot_id` ke semua tabel yang relevan

Setiap tabel yang menyimpan data planning wajib punya `depot_id`. Ini bukan foreign key ke tabel depot yang kompleks — cukup `text NOT NULL`. Enum depot dikelola di level aplikasi.

Tabel yang wajib ditambahkan `depot_id`:
```
plans          — satu plan milik satu depot
plan_jobs      — satu job milik satu depot
stores         — master data toko per depot
assignments    — hasil assignment toko ke sales
route_summaries — summary beban per sales per depot
```

### 1.2 Tabel `plan_jobs` (baru, wajib dibuat)

```sql
CREATE TABLE plan_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  depot_id        text NOT NULL,
  plan_config     jsonb NOT NULL,        -- seluruh config plan (n_sales, philosophy, dst)
  status          text NOT NULL DEFAULT 'QUEUED',
                                         -- QUEUED | PROCESSING | DONE | FAILED
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  result_plan_id  uuid,                  -- FK ke tabel plans, diisi saat status = DONE
  error_message   text,                  -- diisi saat status = FAILED
  version_id      uuid DEFAULT gen_random_uuid()
);

CREATE INDEX ON plan_jobs (depot_id, status);
CREATE INDEX ON plan_jobs (status, created_at);  -- untuk worker polling
```

### 1.3 Update output schema (tambahan dari Bagian 9 spec utama)

Tambahkan dua field ke setiap baris assignment output:
```
depot_id    : str    # wajib, dari config plan
job_id      : uuid   # traceability: plan ini generated dari job mana
```

---

## 2. Role Model & RBAC

### 2.1 Tiga role

```python
class UserRole(str, Enum):
    NATIONAL_PLANNER  = "NATIONAL_PLANNER"   # akses semua depot
    REGIONAL_MANAGER  = "REGIONAL_MANAGER"   # akses subset depot (didefinisikan di user record)
    AREA_MANAGER      = "AREA_MANAGER"       # akses satu depot sendiri saja
```

### 2.2 User record

Setiap user punya field `allowed_depot_ids: list[str]` di tabel users.
- `NATIONAL_PLANNER`: `allowed_depot_ids = ["*"]` — wildcard, semua depot.
- `REGIONAL_MANAGER`: list depot di wilayahnya.
- `AREA_MANAGER`: list berisi satu depot saja.

### 2.3 FastAPI dependency — satu fungsi, pakai di semua endpoint

```python
# app/core/auth.py

from fastapi import Depends, HTTPException
from app.core.config import get_current_user  # sudah ada dari auth_router

def get_allowed_depots(current_user=Depends(get_current_user)) -> list[str]:
    """
    Kembalikan list depot_id yang boleh diakses user ini.
    Wildcard ["*"] diterjemahkan ke semua depot di sini.
    """
    if current_user.role == UserRole.NATIONAL_PLANNER:
        return fetch_all_depot_ids()  # query sekali, bisa di-cache
    return current_user.allowed_depot_ids

def assert_depot_access(depot_id: str, allowed: list[str] = Depends(get_allowed_depots)):
    """
    Guard untuk endpoint yang menerima depot_id spesifik.
    Raise 403 kalau depot_id tidak ada di list yang diizinkan.
    """
    if depot_id not in allowed:
        raise HTTPException(status_code=403, detail="Depot access denied")
```

### 2.4 Pola penggunaan di setiap endpoint

```python
@router.get("/plans")
def list_plans(allowed_depots: list[str] = Depends(get_allowed_depots)):
    return supabase.table("plans")\
        .select("*")\
        .in_("depot_id", allowed_depots)\
        .execute()

@router.get("/plans/{plan_id}")
def get_plan(plan_id: str, allowed_depots: list[str] = Depends(get_allowed_depots)):
    plan = supabase.table("plans").select("*").eq("id", plan_id).single().execute()
    if plan.data["depot_id"] not in allowed_depots:
        raise HTTPException(status_code=403)
    return plan.data
```

**Prinsip:** filter `depot_id` wajib ada di SETIAP query yang menyentuh data planning. Tidak ada exception. Coding agent wajib enforce ini via linting/review sebelum merge.

---

## 3. Async Job Queue

### Mengapa dibutuhkan

Kalau 10 area manager klik "generate plan" bersamaan, FastAPI tidak boleh menjalankan 10 clustering job berat serentak di main thread — server tersedak, semua request timeout. Solusi: request masuk langsung kembali dengan `job_id`; heavy computation jalan di background dengan batas concurrency.

### Tidak butuh infrastruktur baru

Supabase `plan_jobs` sebagai queue + asyncio worker di FastAPI startup. Tidak ada Celery, tidak ada Redis, tidak ada Cloud Tasks.

### 3.1 API contract (berubah dari spec utama)

```
POST /plans/generate
  body: PlanConfig (n_sales, philosophy, depot_id, dst.)
  response: 202 Accepted
  {
    "job_id": "uuid",
    "status": "QUEUED",
    "message": "Plan sedang diproses. Poll /plans/jobs/{job_id} untuk status."
  }

GET /plans/jobs/{job_id}
  response: {
    "job_id": "uuid",
    "status": "QUEUED | PROCESSING | DONE | FAILED",
    "result_plan_id": "uuid | null",   -- ada kalau DONE
    "error_message": "str | null",     -- ada kalau FAILED
    "started_at": "datetime | null",
    "completed_at": "datetime | null"
  }
```

Frontend polling `/plans/jobs/{job_id}` setiap 3 detik sampai status `DONE` atau `FAILED`. Implementasi polling di frontend, bukan WebSocket — lebih sederhana, cukup untuk use case ini.

### 3.2 Job worker — jalankan di FastAPI lifespan

```python
# app/core/job_worker.py

import asyncio
from app.core.logger import logger

MAX_CONCURRENT_JOBS = 3  # tune: 3 cukup untuk v1, naikkan kalau RAM Cloud Run dinaikkan

async def run_job_worker():
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
    logger.info("Job worker started")
    while True:
        try:
            job = poll_next_queued_job()   # ambil satu job QUEUED, update status → PROCESSING
            if job:
                asyncio.create_task(process_job_with_semaphore(job, semaphore))
            else:
                await asyncio.sleep(2)     # tidak ada job → tunggu 2 detik
        except Exception as e:
            logger.error(f"Worker error: {e}")
            await asyncio.sleep(5)

async def process_job_with_semaphore(job, semaphore):
    async with semaphore:
        await process_job(job)

async def process_job(job):
    try:
        mark_job_started(job["id"])
        config = PlanConfig(**job["plan_config"])
        result = await asyncio.to_thread(run_engine, config)  # engine sync → thread pool
        plan_id = save_plan_result(result, job)
        mark_job_done(job["id"], plan_id)
    except Exception as e:
        mark_job_failed(job["id"], str(e))
        logger.error(f"Job {job['id']} failed: {e}")
```

### 3.3 Daftarkan worker di lifespan (sudah ada di main.py)

```python
# main.py — update lifespan yang sudah ada

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 JKS SFA Engine V2 starting up...")
    worker_task = asyncio.create_task(run_job_worker())   # ← tambahkan ini
    yield
    worker_task.cancel()
    logger.info("🛑 Shutting down gracefully...")
```

### 3.4 Helper functions (implementasi di `app/core/job_queue.py`)

```python
def poll_next_queued_job() -> dict | None:
    """
    Ambil satu job QUEUED paling lama, update status → PROCESSING secara atomic.
    Gunakan Supabase RPC atau select-then-update dengan check status.
    Kembalikan None kalau tidak ada job.
    """

def mark_job_started(job_id: str):
    supabase.table("plan_jobs").update({
        "status": "PROCESSING",
        "started_at": datetime.utcnow().isoformat()
    }).eq("id", job_id).execute()

def mark_job_done(job_id: str, plan_id: str):
    supabase.table("plan_jobs").update({
        "status": "DONE",
        "result_plan_id": plan_id,
        "completed_at": datetime.utcnow().isoformat()
    }).eq("id", job_id).execute()

def mark_job_failed(job_id: str, error: str):
    supabase.table("plan_jobs").update({
        "status": "FAILED",
        "error_message": error,
        "completed_at": datetime.utcnow().isoformat()
    }).eq("id", job_id).execute()
```

---

## 4. Deployment: Dockerfile + Cloud Run

### 4.1 Dockerfile (wajib ada dari hari pertama)

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
```

**Catatan workers=1:** Jangan pakai `--workers` > 1 di Cloud Run karena asyncio job worker harus jalan di satu process. Multi-worker akan spawn multiple worker processes yang masing-masing punya job worker sendiri — race condition pada polling `plan_jobs`. Cloud Run scaling horizontal (multiple container instances) menggantikan kebutuhan multi-worker.

### 4.2 Cloud Run config (v1)

```yaml
# cloud-run-config.yaml — untuk referensi deployment

service: jks-route-engine
region: asia-southeast1   # Singapore

resources:
  cpu: 1
  memory: 1Gi             # naikkan ke 4Gi saat OSMnx v2 aktif

scaling:
  min-instances: 1        # keep warm — jangan scale to zero untuk planning tool
  max-instances: 10
  concurrency: 20         # request concurrency per instance

timeout: 1800             # 30 menit — untuk komputasi berat

env:
  - SUPABASE_URL: [from Secret Manager]
  - SUPABASE_KEY: [from Secret Manager]
  - ENVIRONMENT: production
```

**Kenapa `min-instances: 1`:** Cold start FastAPI + load dependencies bisa 3–8 detik. Area manager yang buka planning tool dan menunggu 8 detik sebelum bisa apa-apa akan menyimpulkan tool-nya lambat. Satu instance warm selalu aktif menghilangkan ini; biayanya ~$5–10/bulan — worth it.

### 4.3 Environment variables — jangan hardcode

```
SUPABASE_URL
SUPABASE_SERVICE_KEY      # bukan anon key — backend butuh service role
ENVIRONMENT               # development | staging | production
LOG_LEVEL                 # INFO untuk prod, DEBUG untuk dev
MAX_CONCURRENT_JOBS       # default 3, override via env kalau perlu
```

Semua secret wajib dari Google Cloud Secret Manager atau Supabase Vault — tidak boleh ada secret di `.env` file yang masuk ke repository.

---

## 5. Acceptance Checks Tambahan

Tambahkan ke checklist Bagian 11 spec utama:

- [ ] **Depot isolation:** query yang mengembalikan data planning selalu include filter `depot_id`. Tidak ada endpoint yang mengembalikan data lintas depot tanpa cek `allowed_depot_ids`.
- [ ] **Role enforcement:** AREA_MANAGER yang coba akses depot lain mendapat 403, bukan data kosong.
- [ ] **Job concurrency:** spawn 10 job serentak → maksimal `MAX_CONCURRENT_JOBS` yang berstatus PROCESSING di waktu yang sama; sisanya QUEUED sampai slot terbuka.
- [ ] **Worker survival:** kill satu job di tengah processing (simulate crash) → job kembali ke QUEUED (atau FAILED dengan error) — tidak tergantung selamanya di PROCESSING.
- [ ] **Single worker process:** pastikan hanya satu job worker berjalan per process. Test dengan `--workers 2` lokal → seharusnya ada warning atau guard.

---

## 6. Yang Tidak Berubah dari Spec Utama

Semua guardrail di Bagian 2 spec utama tetap berlaku tanpa pengecualian. Penambahan `depot_id` dan job queue tidak mengubah:

- Logic engine (geo, partition, scheduling, biweekly, estimator)
- Filosofi BLOCKING dan TRAFFIC
- Pola 6×2
- Acceptance checks engine (Bagian 11 spec utama)
- Prinsip "engine merekomendasi, manusia memutuskan"
