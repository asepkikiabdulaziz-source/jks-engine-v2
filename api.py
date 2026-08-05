# ==============================================================================
# api.py  —  FastAPI service (production)
#
# Architecture: Frontend → FastAPI (auth + orchestration) → Engine → Supabase DB
# Tidak ada middleman TypeScript. Semua backend path adalah Python.
#
# File ini berada di ROOT project (bukan di dalam route_engine/)
# supaya test_no_network_imports tidak menangkap URL CORS sebagai "network call
# di logic engine" — api.py adalah transport layer, bukan logic engine.
#
# Endpoints:
#   POST /generate-plan   — verify JWT, load stores, run engine, save atomik
#   GET  /health
#
# Env vars (wajib):
#   SUPABASE_URL          — https://<ref>.supabase.co
#   SUPABASE_SERVICE_KEY  — service role key (Settings > API > service_role)
#
# Env vars (wajib bila menyajikan frontend 1-container → disuntik ke window.__ENV__):
#   SUPABASE_ANON_KEY     — anon/public key (dikirim ke browser)
#
# Env vars (opsional):
#   ENGINE_URL            — base URL engine utk frontend; kosong → same-origin
#   ALLOWED_ORIGINS       — comma-separated CORS origins
#                           default: http://localhost:3000,http://localhost:5173
# ==============================================================================
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Dict, List, NamedTuple, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from supabase import Client, create_client

# Preflight: verifikasi dependency REQUIRED SEBELUM mengimpor engine, agar
# kegagalan tampil sebagai pesan jelas (bukan ImportError mentah dari modul engine).
# Worker menolak boot bila ada yang hilang — crash terlihat > menyimpang senyap.
from route_engine.core.preflight import verify_dependencies
verify_dependencies()

# Absolute imports — api.py ada di root, bukan di dalam package route_engine/
from route_engine.engine import RouteEngine, SalesTerritory, SalesPartition
from route_engine.models import (
    BalanceCriterion, Cycle, Philosophy, PlanConfig, Store, VisitFrequency,
)
from route_engine.constants import day_name
from route_engine.core.biweekly import split_ganjil_genap
from route_engine.core.estimator import nn_tour
from route_engine.core.geo import centroid
from route_engine.core.partition import balanced_partition
from route_engine.core.qc import run_qc
from route_engine.core.summary import build_summary

logger = logging.getLogger(__name__)

# ── App + CORS ─────────────────────────────────────────────────────────────────
app = FastAPI(title="JKS Route Engine API", version="2.0.0")

_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://localhost:5173",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    # Izinkan semua localhost port (dev: 5173, 3000, 50562, dst.)
    allow_origin_regex=r"http://localhost:\d+",
    allow_credentials=True,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

# ── Config ─────────────────────────────────────────────────────────────────────
# Dibaca saat request agar aman jika env vars di-set setelah import
def _supabase_url()     -> str: return os.getenv("SUPABASE_URL",         "")
def _supabase_svc_key() -> str: return os.getenv("SUPABASE_SERVICE_KEY", "")


# Singleton client — dibuat sekali, dikembalikan di setiap request
_db_client: Optional[Client] = None

def _db() -> Client:
    """
    Service-role Supabase client — bypass RLS, bisa akses jks_engine schema.
    Singleton: create_client() hanya dipanggil sekali per proses worker.
    """
    global _db_client
    if _db_client is None:
        url = _supabase_url()
        key = _supabase_svc_key()
        if not url or not key:
            raise HTTPException(500, "SUPABASE_URL / SUPABASE_SERVICE_KEY not configured")
        _db_client = create_client(url, key)
    return _db_client


def _store_visit_freq(raw_val) -> VisitFrequency:
    """
    Map nilai visit_frequency dari DB → enum engine.

    GAGAL KERAS untuk nilai tak dikenal. Versi lama diam-diam mengembalikan
    BIWEEKLY untuk APA PUN yang bukan "WEEKLY" — dan itulah yang membuat bug
    terbesar di proyek ini hidup di produksi tanpa terdeteksi: kolom DB berisi
    '1' (= MINGGUAN dalam pengkodean Nabati), tak pernah cocok dengan "WEEKLY",
    jadi SELURUH 22.674 toko diperlakukan dua-mingguan dan 20.537 assignment
    dijadwalkan pada separuh frekuensi yang seharusnya — termasuk 2 plan APPROVED.

    Tak satu pun test menangkapnya, karena tak ada yang untuk ditangkap: kodenya
    "berhasil" mengembalikan nilai yang salah. Default senyap tidak punya mode
    kegagalan; ia hanya punya hasil yang salah.

    Sejak migrasi 0009, DB dijamin kanonik lewat CHECK constraint, jadi cabang
    ValueError di bawah seharusnya mustahil tercapai. Ia tetap ada justru karena
    itu — kalau suatu saat tercapai, ada asumsi yang runtuh dan kita ingin
    MENDENGARNYA, bukan diam-diam menjadwalkan separuh kunjungan lagi.
    """
    if raw_val is None or str(raw_val).strip() == "":
        # Kolom NOT NULL sejak 0009; ini berarti pemanggil melewatkan field-nya.
        return VisitFrequency.BIWEEKLY

    val = str(raw_val).strip().upper()
    if val == "WEEKLY":
        return VisitFrequency.WEEKLY
    if val == "BIWEEKLY":
        return VisitFrequency.BIWEEKLY

    # HTTPException, bukan ValueError: api.py transport layer, dan pesan ini harus
    # SAMPAI ke operator. ValueError jadi 500 kosong — loud tapi bisu, dan bisu
    # adalah separuh dari masalah aslinya.
    raise HTTPException(
        500,
        f"visit_frequency tidak dikenali: {raw_val!r}. "
        "Nilai kanonik: WEEKLY | BIWEEKLY (label tampilan: 4/4 | 2/4). "
        "Jalankan migrasi 0009 kalau DB masih menyimpan kode tenant seperti '1'.",
    )


def _verify_jwt(authorization: str = Header(default="")) -> str:
    """
    Verifikasi user JWT via Supabase auth.get_user().
    Tidak butuh SUPABASE_JWT_SECRET — delegasi ke Supabase auth API.
    Return user_id (UUID string).
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    token = authorization[7:]
    try:
        db = _db()
        resp = db.auth.get_user(token)
        if not resp.user:
            raise HTTPException(401, "Unauthorized")
        return str(resp.user.id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(401, f"Unauthorized: {exc}")


# ── Helper: agg dict → schedule output ────────────────────────────────────────

def _agg_to_schedule_out(
    agg: Dict[str, Dict[int, dict]]
) -> "List[SalesScheduleOut]":
    """
    Konversi dict agregasi { sales_name → { day_key → {...} } } ke
    list SalesScheduleOut terurut (sales_name, day_key).

    day_key boleh 0-based (dari _build_from_territories) atau
    1-based (dari plan.assignments) — sort konsisten untuk keduanya.
    """
    return [
        SalesScheduleOut(
            sales_name = sn,
            days = [
                DayOut(
                    day_of_week    = d["dow"],
                    store_count    = len(d["codes"]),
                    customer_codes = d["codes"],
                    ganjil_codes   = d["ganjil"],
                    genap_codes    = d["genap"],
                )
                for _, d in sorted(days_map.items())
            ],
        )
        for sn, days_map in sorted(agg.items())
    ]


class _SummaryRow(NamedTuple):
    """Adapter minimal: `build_summary` cuma butuh tiga field ini.

    Path A menghasilkan dict (bentuk yang diminta `save_plan`), sedangkan
    `build_summary` bekerja atas objek `Assignment`. NamedTuple dipakai alih-alih
    kelas boneka `type("F", (), {...})()` supaya bentuk yang dibutuhkan tertulis
    jelas dan salah-ketik ketahuan, bukan jadi AttributeError saat runtime.
    """
    customer_code:     str
    sales_person_name: str
    day_index:         int


def _summary_from_dicts(assignment_dicts, store_map, depo, qc_flags) -> dict:
    """Hitung summary untuk Path A dengan mesin yang sama seperti Path B.

    Sebelum ini `generate_plan` menyimpan `summary_map[div] = {}` untuk Path A —
    plan tersimpan tanpa metrik beban maupun sebar, padahal Path B punya keduanya.
    Dua plan yang dibuat lewat jalur berbeda jadi tidak sebanding, dan tak ada apa
    pun di data yang menjelaskan kenapa.
    """
    rows = [
        _SummaryRow(a["customer_code"], a["sales_person_name"], a["day_index"])
        for a in assignment_dicts
    ]
    return build_summary(rows, store_map, start=depo, qc_flags=qc_flags)


# ── Shared output models ───────────────────────────────────────────────────────

class TerritoryOut(BaseModel):
    sales_index:    int
    sales_name:     str
    store_count:    int
    centroid_lat:   float
    centroid_lon:   float
    customer_codes: List[str]


# ── Preview models (dry_run=True) ──────────────────────────────────────────────

class DayOut(BaseModel):
    day_of_week    : str
    store_count    : int
    customer_codes : List[str]   # semua toko hari ini
    ganjil_codes   : List[str]   # toko yang visit minggu ganjil (M2)
    genap_codes    : List[str]   # toko yang visit minggu genap (M2)

class SalesScheduleOut(BaseModel):
    sales_name : str
    days       : List[DayOut]

class DivPreviewOut(BaseModel):
    div_sls     : str
    territories : List[TerritoryOut]
    schedule    : List[SalesScheduleOut]

class PreviewResponse(BaseModel):
    divisions : List[DivPreviewOut]


# ── Request / Response Models ──────────────────────────────────────────────────

class TerritoryIn(BaseModel):
    """Territory yang sudah ditentukan (dari Stage 1, mungkin sudah diedit user)."""
    sales_index    : int
    sales_name     : str
    customer_codes : List[str]


class ScheduleDayIn(BaseModel):
    """Satu hari dalam schedule_override (hasil edit manual hari/pekan di s2_preview).

    Keanggotaan pekan menentukan pola kunjungan tiap toko:
      - di ganjil_codes  → M2C13 (kunjungi pekan ganjil)
      - di genap_codes   → M2C24 (kunjungi pekan genap)
      - hanya di customer_codes → M1 (kunjungi tiap pekan)
    """
    day_of_week    : str
    customer_codes : List[str]
    ganjil_codes   : List[str] = []
    genap_codes    : List[str] = []


class SalesScheduleIn(BaseModel):
    sales_name : str
    days       : List[ScheduleDayIn]


class DivisionIn(BaseModel):
    div_sls:           str
    n_sales:           int   = Field(..., ge=1, le=200)
    work_days:         int   = Field(..., ge=1, le=7)
    cycle:             str   = Field(..., pattern=r"^(M1|M2)$")
    philosophy:        str   = Field(..., pattern=r"^(BLOCKING|TRAFFIC)$")
    balance_tolerance: float = Field(default=0.10, ge=0.05, le=0.50)
    # Optional: pre-assigned territories dari Stage 1 + adjustment
    # Jika disediakan, K-Means partitioning di-skip; langsung ke day scheduling
    territories: Optional[List[TerritoryIn]] = None
    # Optional: jadwal hasil edit manual hari/pekan (s2_preview). Jika ada,
    # penempatan hari/pekan diambil apa adanya dari sini (skip K-Means hari).
    schedule_override: Optional[List[SalesScheduleIn]] = None


class GeneratePlanRequest(BaseModel):
    area_id:   str
    kd_dist:   str
    depo_lat:  float
    depo_lon:  float
    divisions: List[DivisionIn]
    dry_run:   bool = False   # True → preview saja, jangan simpan ke DB


class GeneratePlanResponse(BaseModel):
    # dry_run=False: plan_id + plan_name terisi, preview=None
    plan_id:   Optional[str]      = None
    plan_name: Optional[str]      = None
    # dry_run=True: preview terisi, plan_id=None
    preview:   Optional[PreviewResponse] = None


# ── Stage 2 models ─────────────────────────────────────────────────────────────

class Stage2DivisionIn(BaseModel):
    div_sls:           str
    n_sales:           int   = Field(default=1, ge=1, le=200)   # dipakai TRAFFIC: partisi sales per hari
    work_days:         int   = Field(..., ge=1, le=7)
    cycle:             str   = Field(..., pattern=r"^(M1|M2)$")
    philosophy:        str   = Field(..., pattern=r"^(BLOCKING|TRAFFIC)$")
    balance_tolerance: float = Field(default=0.10, ge=0.05, le=0.50)


class Stage2Request(BaseModel):
    area_id:     str
    kd_dist:     str
    depo_lat:    float
    depo_lon:    float
    division:    Stage2DivisionIn
    territories: List[TerritoryIn]   # hasil Stage 1, mungkin sudah diedit


class Stage2Response(BaseModel):
    div_sls     : str
    territories : List[TerritoryOut]
    schedule    : List[SalesScheduleOut]


# ── Stage 1 models ─────────────────────────────────────────────────────────────

class Stage1DivisionIn(BaseModel):
    div_sls:           str
    n_sales:           int   = Field(..., ge=1, le=200)
    work_days:         int   = Field(default=6, ge=1, le=7)
    philosophy:        str   = Field(default="BLOCKING", pattern=r"^(BLOCKING|TRAFFIC)$")
    balance_tolerance: float = Field(default=0.10, ge=0.05, le=0.50)


class Stage1Request(BaseModel):
    area_id:   str
    kd_dist:   str
    depo_lat:  float
    depo_lon:  float
    divisions: List[Stage1DivisionIn]


class DivisionPartitionOut(BaseModel):
    div_sls:     str
    territories: List[TerritoryOut]


class Stage1Response(BaseModel):
    results: List[DivisionPartitionOut]


# ── Endpoint ───────────────────────────────────────────────────────────────────
@app.post("/generate-plan", response_model=GeneratePlanResponse)
def generate_plan(
    req:     GeneratePlanRequest,
    user_id: str = Depends(_verify_jwt),
) -> GeneratePlanResponse:
    """
    Orchestration endpoint dengan dua mode:

    dry_run=True  → generate preview (territories + jadwal per sales per hari),
                    TIDAK simpan ke DB. Dipakai saat user klik "Preview Jadwal"
                    per divisi untuk review sebelum commit.

    dry_run=False → generate + simpan atomik ke DB. Semua divisi di-pass
                    sekaligus → satu plan_id untuk seluruh depo.
    """
    db = _db()

    # ── Load stores ────────────────────────────────────────────────────────────
    stores_res = db.rpc("get_stores_by_area", {"p_area_id": req.area_id, "p_caller_id": user_id}).execute()
    raw_stores: list[dict] = stores_res.data or []
    if not raw_stores:
        raise HTTPException(400, "Belum ada toko aktif untuk area ini")

    # ── Siapkan plan_id + plan_name (hanya dipakai saat dry_run=False) ─────────
    plan_id   = str(uuid.uuid4())
    plan_name = ""
    if not req.dry_run:
        ver_res   = db.rpc("next_plan_version", {"p_area_id": req.area_id}).execute()
        ver       = ver_res.data if ver_res.data else 1
        today     = datetime.now(timezone.utc).strftime("%Y%m%d")
        plan_name = f"{req.kd_dist}_{today}_V{ver}"

    # ── Run engine per divisi ──────────────────────────────────────────────────
    engine_inst   = RouteEngine()
    all_assignments: list[dict]  = []
    version_ids:    dict[str, str]  = {}
    summary_map:    dict[str, dict] = {}
    preview_divs:   list[DivPreviewOut] = []

    for div in req.divisions:
        div_raw = [s for s in raw_stores if s.get("div_sls") == div.div_sls]
        if not div_raw:
            logger.warning("Division %s: 0 stores — skipped", div.div_sls)
            continue

        stores = [
            Store(
                customer_code=s["customer_code"],
                latitude=float(s["latitude"]),
                longitude=float(s["longitude"]),
                visit_frequency=_store_visit_freq(s.get("visit_frequency")),
            )
            for s in div_raw
        ]

        # ── Path A: territories pre-assigned (dari adjustment) ────────────────
        if div.territories:
            vid = str(uuid.uuid4())
            store_map = {s.customer_code: s for s in stores}
            if div.schedule_override:
                # Edit manual hari/pekan (s2_preview) → pakai jadwal apa adanya
                t_out, s_out, a_dicts, a_summary = _build_from_override(
                    store_map         = store_map,
                    territories       = div.territories,
                    schedule_override = div.schedule_override,
                    philosophy        = div.philosophy,
                    div_sls           = div.div_sls,
                    version_id        = vid,
                    depo_lat          = req.depo_lat,
                    depo_lon          = req.depo_lon,
                )
            else:
                t_out, s_out, a_dicts, a_summary = _build_from_territories(
                    store_map         = store_map,
                    territories       = div.territories,
                    n_sales           = div.n_sales,
                    work_days         = div.work_days,
                    cycle             = div.cycle,
                    philosophy        = div.philosophy,
                    depo_lat          = req.depo_lat,
                    depo_lon          = req.depo_lon,
                    kd_dist           = req.kd_dist,
                    div_sls           = div.div_sls,
                    plan_id           = f"{plan_id}-{div.div_sls}",
                    version_id        = vid,
                    balance_tolerance = div.balance_tolerance,
                )
            logger.info(
                "Division %s (locked territories): %d stores → %d assignments",
                div.div_sls, len(stores), len(a_dicts),
            )
            if req.dry_run:
                preview_divs.append(DivPreviewOut(
                    div_sls=div.div_sls, territories=t_out, schedule=s_out,
                ))
            else:
                version_ids[div.div_sls] = vid
                summary_map[div.div_sls] = a_summary
                all_assignments.extend(a_dicts)
            continue

        # ── Path B: K-Means baru (original) ──────────────────────────────────
        config = PlanConfig(
            n_sales=div.n_sales,
            depo_lat=req.depo_lat,
            depo_lon=req.depo_lon,
            work_days=div.work_days,
            cycle=Cycle(div.cycle),
            philosophy=Philosophy(div.philosophy),
            balance_criterion=BalanceCriterion.COUNT,
            balance_tolerance=div.balance_tolerance,
            depo_id=req.kd_dist,
            base_name=div.div_sls,
        )

        plan = engine_inst.run(stores, config, plan_id=f"{plan_id}-{div.div_sls}")
        logger.info(
            "Division %s: %d stores → %d assignments (version %s)",
            div.div_sls, len(stores), len(plan.assignments), plan.version_id,
        )

        if req.dry_run:
            # ── Territories: re-run partisi sesuai filosofi (deterministik) ────
            if div.philosophy == "TRAFFIC":
                partition = engine_inst.partition_days(stores, config, div.div_sls)
            else:
                partition = engine_inst.partition_sales(stores, config, div.div_sls)
            territories_out = [
                TerritoryOut(
                    sales_index    = t.sales_index,
                    sales_name     = t.sales_name,
                    store_count    = t.store_count,
                    centroid_lat   = t.centroid_lat,
                    centroid_lon   = t.centroid_lon,
                    customer_codes = t.customer_codes,
                )
                for t in partition.territories
            ]

            # ── Jadwal per sales per hari dari assignments ────────────────────
            agg: Dict[str, Dict[int, dict]] = {}
            for a in plan.assignments:
                sn = a.sales_person_name
                agg.setdefault(sn, {})
                if a.day_index not in agg[sn]:
                    agg[sn][a.day_index] = {"dow": a.day_of_week, "codes": [], "ganjil": [], "genap": []}
                d   = agg[sn][a.day_index]
                vg  = getattr(a, "visit_ganjil", False)
                ve  = getattr(a, "visit_genap",  False)
                d["codes"].append(a.customer_code)
                if vg and not ve:   d["ganjil"].append(a.customer_code)
                elif ve and not vg: d["genap"].append(a.customer_code)
            schedule_out = _agg_to_schedule_out(agg)

            preview_divs.append(DivPreviewOut(
                div_sls=div.div_sls,
                territories=territories_out,
                schedule=schedule_out,
            ))

        else:
            # ── Kumpulkan assignments untuk save ─────────────────────────────
            version_ids[div.div_sls] = plan.version_id
            summary_map[div.div_sls] = plan.summary

            for a in plan.assignments:
                all_assignments.append({
                    "div_sls":           div.div_sls,
                    "customer_code":     a.customer_code,
                    "sales_person_name": a.sales_person_name,
                    "philosophy":        a.philosophy,
                    "day_index":         a.day_index,
                    "day_of_week":       a.day_of_week,
                    "visit_cycle":       a.visit_cycle,
                    "visit_ganjil":      a.visit_ganjil,
                    "visit_genap":       a.visit_genap,
                    "visit_order":       a.visit_order,
                    "qc_flag":           a.qc_flag,
                    "version_id":        plan.version_id,
                })

    # ── dry_run=True: kembalikan preview tanpa save ────────────────────────────
    if req.dry_run:
        if not preview_divs:
            raise HTTPException(400, "Tidak ada divisi yang berhasil diproses")
        return GeneratePlanResponse(preview=PreviewResponse(divisions=preview_divs))

    # ── dry_run=False: simpan atomik ke DB ────────────────────────────────────
    if not all_assignments:
        raise HTTPException(400, "Tidak ada toko yang berhasil diproses untuk divisi ini")

    divisions_meta = [
        {
            **d.model_dump(),
            "store_count": sum(1 for s in raw_stores if s.get("div_sls") == d.div_sls),
        }
        for d in req.divisions
    ]

    db.rpc("save_plan", {
        "p_plan_id":     plan_id,
        "p_area_id":     req.area_id,
        "p_plan_name":   plan_name,
        "p_divisions":   divisions_meta,
        "p_version_ids": version_ids,
        "p_summary":     summary_map,
        "p_created_by":  user_id,
        "p_assignments": all_assignments,
    }).execute()

    logger.info(
        "Plan saved: %s (%s), %d assignments", plan_name, plan_id, len(all_assignments),
    )

    return GeneratePlanResponse(plan_id=plan_id, plan_name=plan_name)


# ── Helper: build schedule + assignments dari territories pre-assigned ────────

def _build_from_territories(
    store_map         : dict,             # {customer_code: Store}
    territories       : List[TerritoryIn],
    work_days         : int,
    cycle             : str,
    philosophy        : str,
    depo_lat          : float,
    depo_lon          : float,
    kd_dist           : str,
    div_sls           : str,
    plan_id           : str,
    version_id        : str,
    n_sales           : int   = 1,     # dipakai TRAFFIC: partisi sales per hari
    balance_tolerance : float = 0.10,  # toleransi kerataan sub-partisi TRAFFIC
) -> "tuple[List[TerritoryOut], List[SalesScheduleOut], List[dict], dict]":
    """
    Dari territories pre-assigned, jalankan day/sales scheduling.
    Skip K-Means — langsung ke assignment dari territories yang ada.

    BLOCKING (territories = wilayah sales):
      Setiap territory → balanced_partition (K-Means) → day blocks.

    TRAFFIC (territories = hari-zones, hasil partition_days()):
      Setiap territory → balanced_partition(n_sales) → sales blocks per hari.

    Return: (territories_out, schedule_out, assignment_dicts)
      - territories_out  : untuk preview peta
      - schedule_out     : untuk preview panel
      - assignment_dicts : untuk simpan ke DB via save_plan RPC
    """
    from collections import defaultdict as _dd

    is_m2      = Cycle(cycle) == Cycle.M2
    is_traffic = philosophy == Philosophy.TRAFFIC.value
    depo       = (depo_lat, depo_lon)

    blocks: dict              = _dd(list)   # (sales_idx, day_idx0) → [Store]
    territories_out: List[TerritoryOut] = []

    for t in territories:
        t_stores = [store_map[c] for c in t.customer_codes if c in store_map]
        if not t_stores:
            continue

        ct_lat, ct_lon = centroid([s.coord for s in t_stores])

        if is_traffic:
            # TRAFFIC: territory = day-zone (sales_index = day_idx, sales_name = hari)
            day_idx = t.sales_index
            if n_sales > 1 and len(t_stores) >= n_sales:
                sales_labels = balanced_partition(
                    t_stores, n_sales,
                    criterion=BalanceCriterion.COUNT,
                    random_state=42,
                    tolerance=balance_tolerance,
                )
                for s in t_stores:
                    blocks[(sales_labels[s.customer_code], day_idx)].append(s)
            else:
                for s in t_stores:
                    blocks[(0, day_idx)].append(s)
        else:
            # BLOCKING: territory = wilayah sales → split hari murni K-Means
            day_labels = balanced_partition(
                t_stores, work_days,
                criterion=BalanceCriterion.COUNT,
                random_state=42,
                tolerance=balance_tolerance,
            )
            for s in t_stores:
                blocks[(t.sales_index, day_labels[s.customer_code])].append(s)

        territories_out.append(TerritoryOut(
            sales_index    = t.sales_index,
            sales_name     = t.sales_name,
            store_count    = len(t_stores),
            centroid_lat   = ct_lat,
            centroid_lon   = ct_lon,
            customer_codes = [s.customer_code for s in t_stores],
        ))

    # ── Stage 0: QC ────────────────────────────────────────────────────────────
    # Path B (engine.run) menjalankan ini sejak awal; Path A dulu tidak, dan
    # mengeset qc_flag=None secara harfiah. Akibatnya plan dari jalur yang PALING
    # SERING dipakai tersimpan tanpa penanda mutu sama sekali — beda diam-diam
    # dari Path B, dan tak ada apa pun di keluaran yang menunjukkannya.
    qc_flags = run_qc(list(store_map.values()))
    qc_map: Dict[str, str] = {}
    for f in qc_flags:
        qc_map.setdefault(f.customer_code, f.reason)

    # ── Stage 3: sequencing per blok (sales, hari) ─────────────────────────────
    agg: Dict[str, Dict[int, dict]] = {}       # sn → {day_idx0 → {...}}
    assignment_dicts: List[dict] = []

    for (sales_idx, day_idx0) in sorted(blocks):
        block_stores = blocks[(sales_idx, day_idx0)]
        ordered      = nn_tour(block_stores, depo)
        gg           = split_ganjil_genap(ordered) if is_m2 else None
        day_index    = day_idx0 + 1
        dow          = day_name(day_idx0)

        if is_traffic:
            # TRAFFIC: sales_name derived dari sales_idx (konsisten cross-hari)
            sales_name = f"{kd_dist}-{div_sls}-{sales_idx+1:02d}"
        else:
            # BLOCKING: sales_name dari territory
            t_info     = next((t for t in territories if t.sales_index == sales_idx), None)
            sales_name = t_info.sales_name if t_info else f"{kd_dist}-{div_sls}-{sales_idx+1:02d}"

        agg.setdefault(sales_name, {})
        if day_idx0 not in agg[sales_name]:
            agg[sales_name][day_idx0] = {"dow": dow, "codes": [], "ganjil": [], "genap": []}
        d = agg[sales_name][day_idx0]

        for visit_order, s in enumerate(ordered, 1):
            ganjil, genap = (gg[s.customer_code] if is_m2 and gg else (True, True))

            d["codes"].append(s.customer_code)
            if ganjil and not genap:   d["ganjil"].append(s.customer_code)
            elif genap and not ganjil: d["genap"].append(s.customer_code)

            assignment_dicts.append({
                "div_sls":           div_sls,
                "customer_code":     s.customer_code,
                "sales_person_name": sales_name,
                "philosophy":        philosophy,
                "day_index":         day_index,
                "day_of_week":       dow,
                "visit_cycle":       cycle,
                "visit_ganjil":      ganjil,
                "visit_genap":       genap,
                "visit_order":       visit_order,
                "qc_flag":           qc_map.get(s.customer_code),
                "version_id":        version_id,
            })

    summary = _summary_from_dicts(assignment_dicts, store_map, depo, qc_flags)
    return territories_out, _agg_to_schedule_out(agg), assignment_dicts, summary


# ── Helper: build assignments dari schedule_override (edit manual s2_preview) ──

_DOW_TO_IDX0 = {
    "Senin": 0, "Selasa": 1, "Rabu": 2, "Kamis": 3, "Jumat": 4, "Sabtu": 5, "Minggu": 6,
}


def _build_from_override(
    store_map         : dict,
    territories       : List[TerritoryIn],
    schedule_override : List["SalesScheduleIn"],
    philosophy        : str,
    div_sls           : str,
    version_id        : str,
    depo_lat          : float,
    depo_lon          : float,
) -> "tuple[List[TerritoryOut], List[SalesScheduleOut], List[dict], dict]":
    """
    Bangun assignment LANGSUNG dari jadwal hasil edit manual user (s2_preview).
    Hari & pekan diambil apa adanya dari override — TIDAK ada penjadwalan ulang.
    `visit_order` = urutan sederhana (provisional; optimasi rute road-aware menyusul).

    Keanggotaan pekan → pola kunjungan per toko:
      - code di ganjil_codes saja    → M2C13 (ganjil)
      - code di genap_codes saja     → M2C24 (genap)
      - code hanya di customer_codes → M1 (tiap pekan: ganjil = genap = True)
    """
    # territories_out: kepemilikan sales tidak berubah di s2 — untuk konsistensi preview
    depo = (depo_lat, depo_lon)
    territories_out: List[TerritoryOut] = []
    for t in territories:
        t_stores = [store_map[c] for c in t.customer_codes if c in store_map]
        if not t_stores:
            continue
        ct_lat, ct_lon = centroid([s.coord for s in t_stores])
        territories_out.append(TerritoryOut(
            sales_index    = t.sales_index,
            sales_name     = t.sales_name,
            store_count    = len(t_stores),
            centroid_lat   = ct_lat,
            centroid_lon   = ct_lon,
            customer_codes = [s.customer_code for s in t_stores],
        ))

    # QC dijalankan di sini juga. Override memang menghormati keputusan manusia soal
    # HARI dan PEKAN -- tapi mutu KOORDINAT bukan keputusan manusia, dan menandainya
    # tidak mengubah satu pun penempatan.
    qc_flags = run_qc(list(store_map.values()))
    qc_map: Dict[str, str] = {}
    for f in qc_flags:
        qc_map.setdefault(f.customer_code, f.reason)

    agg: Dict[str, Dict[int, dict]] = {}
    assignment_dicts: List[dict] = []

    for sales in schedule_override:
        sn = sales.sales_name
        agg.setdefault(sn, {})
        for day in sales.days:
            dow        = day.day_of_week
            day_idx0   = _DOW_TO_IDX0.get(dow, 0)
            day_index  = day_idx0 + 1
            ganjil_set = set(day.ganjil_codes)
            genap_set  = set(day.genap_codes)

            if day_idx0 not in agg[sn]:
                agg[sn][day_idx0] = {"dow": dow, "codes": [], "ganjil": [], "genap": []}
            d = agg[sn][day_idx0]

            for visit_order, code in enumerate(day.customer_codes, 1):
                if code not in store_map:
                    continue
                in_g = code in ganjil_set
                in_e = code in genap_set
                if in_g and not in_e:
                    ganjil, genap, vcycle = True, False, "M2"
                elif in_e and not in_g:
                    ganjil, genap, vcycle = False, True, "M2"
                else:
                    ganjil, genap, vcycle = True, True, "M1"

                d["codes"].append(code)
                if ganjil and not genap:   d["ganjil"].append(code)
                elif genap and not ganjil: d["genap"].append(code)

                assignment_dicts.append({
                    "div_sls":           div_sls,
                    "customer_code":     code,
                    "sales_person_name": sn,
                    "philosophy":        philosophy,
                    "day_index":         day_index,
                    "day_of_week":       dow,
                    "visit_cycle":       vcycle,
                    "visit_ganjil":      ganjil,
                    "visit_genap":       genap,
                    "visit_order":       visit_order,
                    "qc_flag":           qc_map.get(code),
                    "version_id":        version_id,
                })

    summary = _summary_from_dicts(assignment_dicts, store_map, depo, qc_flags)
    return territories_out, _agg_to_schedule_out(agg), assignment_dicts, summary


# ── Stage 2: day scheduling dari territories pre-assigned ─────────────────────

@app.post("/stage2", response_model=Stage2Response)
def stage2(
    req:     Stage2Request,
    user_id: str = Depends(_verify_jwt),
) -> Stage2Response:
    """
    Stage 2: penjadwalan hari dari territories yang sudah ditentukan (mungkin sudah
    diedit user setelah Stage 1). K-Means di-skip — menggunakan customer_codes
    dari territories yang disediakan.

    Hasil: territories + jadwal per sales per hari (preview, tidak simpan ke DB).
    Jika user ingin simpan, panggil /generate-plan dengan field territories per divisi.
    """
    db = _db()

    stores_res = db.rpc("get_stores_by_area", {"p_area_id": req.area_id, "p_caller_id": user_id}).execute()
    raw_stores: list[dict] = stores_res.data or []
    if not raw_stores:
        raise HTTPException(400, "Belum ada toko aktif untuk area ini")

    div = req.division
    div_raw = [s for s in raw_stores if s.get("div_sls") == div.div_sls]
    if not div_raw:
        raise HTTPException(400, f"Tidak ada toko untuk divisi {div.div_sls}")

    store_map = {
        s["customer_code"]: Store(
            customer_code  = s["customer_code"],
            latitude       = float(s["latitude"]),
            longitude      = float(s["longitude"]),
            visit_frequency= _store_visit_freq(s.get("visit_frequency")),
        )
        for s in div_raw
    }

    territories_out, schedule_out, _, _ = _build_from_territories(
        store_map         = store_map,
        territories       = req.territories,
        n_sales           = div.n_sales,
        work_days         = div.work_days,
        cycle             = div.cycle,
        philosophy        = div.philosophy,
        depo_lat          = req.depo_lat,
        depo_lon          = req.depo_lon,
        kd_dist           = req.kd_dist,
        div_sls           = div.div_sls,
        plan_id           = "preview",
        version_id        = str(uuid.uuid4()),
        balance_tolerance = div.balance_tolerance,
    )

    if not territories_out:
        raise HTTPException(400, "Tidak ada toko yang bisa dijadwalkan")

    logger.info(
        "Stage2 done: area=%s, div=%s, %d territories",
        req.area_id, div.div_sls, len(territories_out),
    )
    return Stage2Response(
        div_sls     = div.div_sls,
        territories = territories_out,
        schedule    = schedule_out,
    )


# ── Stage 1: partition sales (preview, tidak simpan ke DB) ────────────────────

@app.post("/stage1", response_model=Stage1Response)
def stage1(
    req:     Stage1Request,
    user_id: str = Depends(_verify_jwt),
) -> Stage1Response:
    """
    Stage 1 saja: partisi toko ke N wilayah sales per divisi.
    TIDAK menyimpan ke DB — hasilnya untuk preview di peta frontend.
    Stage 2 (penjadwalan + simpan) dilakukan via /generate-plan.
    """
    db = _db()

    stores_res = db.rpc("get_stores_by_area", {"p_area_id": req.area_id, "p_caller_id": user_id}).execute()
    raw_stores: list[dict] = stores_res.data or []
    if not raw_stores:
        raise HTTPException(400, "Belum ada toko aktif untuk area ini")

    engine  = RouteEngine()
    results: list[DivisionPartitionOut] = []

    for div in req.divisions:
        div_raw = [s for s in raw_stores if s.get("div_sls") == div.div_sls]
        if not div_raw:
            logger.warning("Stage1 division %s: 0 stores — skipped", div.div_sls)
            continue

        stores = [
            Store(
                customer_code=s["customer_code"],
                latitude=float(s["latitude"]),
                longitude=float(s["longitude"]),
                visit_frequency=_store_visit_freq(s.get("visit_frequency")),
            )
            for s in div_raw
        ]

        config = PlanConfig(
            n_sales=div.n_sales,
            depo_lat=req.depo_lat,
            depo_lon=req.depo_lon,
            work_days=div.work_days,
            philosophy=Philosophy(div.philosophy),
            balance_tolerance=div.balance_tolerance,
            balance_criterion=BalanceCriterion.COUNT,
            depo_id=req.kd_dist,
            base_name=div.div_sls,
        )

        # TRAFFIC Stage 1: partisi ke hari (day-zones, "keroyokan")
        # BLOCKING Stage 1: partisi ke wilayah sales
        if div.philosophy == "TRAFFIC":
            partition: SalesPartition = engine.partition_days(stores, config, div.div_sls)
        else:
            partition = engine.partition_sales(stores, config, div.div_sls)

        results.append(DivisionPartitionOut(
            div_sls=partition.div_sls,
            territories=[
                TerritoryOut(
                    sales_index    = t.sales_index,
                    sales_name     = t.sales_name,
                    store_count    = t.store_count,
                    centroid_lat   = t.centroid_lat,
                    centroid_lon   = t.centroid_lon,
                    customer_codes = t.customer_codes,
                )
                for t in partition.territories
            ],
        ))

    logger.info(
        "Stage1 done: area=%s, %d divisions, %d territories total",
        req.area_id, len(results), sum(len(r.territories) for r in results),
    )
    return Stage1Response(results=results)


# ── Health ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": "2.0.0"}


# ── Static frontend (SPA) + runtime config — deploy "git saja" ────────────────
# api.py = transport layer (bukan logic engine), jadi aman menyajikan file statis.
# Bila folder dist/ ADA (hasil `vite build`, di-COPY ke image oleh Dockerfile root),
# FastAPI menyajikannya pada origin yang sama → tanpa CORS, tanpa mixed-content.
#
# RUNTIME CONFIG: nilai Supabase di-suntik ke index.html SAAT DISAJIKAN (bukan
# di-inline saat build) sebagai window.__ENV__. Maka image sama bisa deploy ke
# host mana pun cukup dengan env var runtime — TANPA build-arg. Inilah yang
# membuat Cloud Run "deploy dari git" jalan tanpa cloudbuild.yaml.
#
# Bila dist/ TIDAK ada (mode dev / image engine-only), blok ini di-skip → API-only.
# PENTING: didaftarkan PALING AKHIR agar route API (+ /docs, /openapi.json) menang.
_DIST_DIR = os.path.normpath(
    os.getenv("FRONTEND_DIST", os.path.join(os.path.dirname(__file__), "dist"))
)

if os.path.isdir(_DIST_DIR):
    import json

    from fastapi.responses import FileResponse, HTMLResponse
    from fastapi.staticfiles import StaticFiles

    _assets_dir = os.path.join(_DIST_DIR, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    _index_html = os.path.join(_DIST_DIR, "index.html")

    def _render_index() -> "HTMLResponse":
        # index.html + window.__ENV__ (config runtime dibaca frontend saat boot).
        with open(_index_html, encoding="utf-8") as fh:
            html = fh.read()
        cfg = {
            "SUPABASE_URL": os.getenv("SUPABASE_URL", ""),
            "SUPABASE_ANON_KEY": os.getenv("SUPABASE_ANON_KEY", ""),
            "ENGINE_URL": os.getenv("ENGINE_URL", ""),  # kosong → engine same-origin
        }
        # .replace("<", …) mencegah breakout </script> bila ada nilai mengandung '<'.
        payload = json.dumps(cfg).replace("<", "\\u003c")
        html = html.replace("</head>", "<script>window.__ENV__=" + payload + "</script></head>", 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        # File statis nyata (favicon.ico, vite.svg, dst.) → sajikan apa adanya.
        candidate = os.path.normpath(os.path.join(_DIST_DIR, full_path))
        in_dist = candidate == _DIST_DIR or candidate.startswith(_DIST_DIR + os.sep)
        if in_dist and full_path not in ("", "index.html") and os.path.isfile(candidate):
            return FileResponse(candidate)
        # Route SPA (mis. /routing) atau index → suntik runtime config lalu sajikan.
        return _render_index()

    logger.info("Frontend statis + runtime config dilayani dari %s", _DIST_DIR)
else:
    logger.info("dist/ tidak ditemukan — mode API-only (frontend dilayani terpisah)")
