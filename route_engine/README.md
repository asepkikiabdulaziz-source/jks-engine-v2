# JKS Route Engine v2

Penimbang & perekomendasi desain teritori + jadwal kunjungan salesman.
**Engine merekomendasi, manusia memutuskan** (lihat `route_engine_v2_build_spec.md`).

## Struktur (spec §10)

```
route_engine/
  models.py            Kontrak data (§3) + skema output (§9): Store, PlanConfig, Assignment
  constants.py         Day names, default random_state, threshold QC
  core/
    geo.py             haversine, bearing, centroid            (SALVAGE math lama)
    qc.py              gross_outlier_check, stacked_coordinate_check  (SATU-SATUNYA pemakai GADM)
    partition.py       balanced_partition (+ fallback wajib)
    scheduling.py      build_blocking, build_traffic            (murni K-Means)
    biweekly.py        split_ganjil_genap (selang-seling sepanjang tur)
    estimator.py       nn_tour, nn_tour_length, load_score      (pintu tunggal beban)
    summary.py         build_summary (count DAN est_route_length)
  engine.py            orkestrasi + versioning + locking + edit lokal
  tests/               acceptance checks (§11)
```

## Pakai

```python
from route_engine.engine import RouteEngine
from route_engine.models import Store, PlanConfig, Cycle, Philosophy

stores = [Store("C0001", -8.10, 113.20), ...]
config = PlanConfig(n_sales=4, depo_lat=-8.30, depo_lon=113.00,
                    work_days=6, cycle=Cycle.M2, philosophy=Philosophy.BLOCKING)

eng  = RouteEngine()
plan = eng.run(stores, config, plan_id="PLAN-001")

plan.assignments      # list[Assignment]  (§9)
plan.summary          # as-is → to-be     (§9)
plan.version_id       # deterministik dari input+config

# Gate manusia (§4, §7)
plan.lock_territory()                 # GATE 1 (BLOCKING): kepemilikan sales beku
plan.move_store("C0001", to_day_index=3)   # edit lokal: hanya sentuh hari sumber & tujuan
plan.lock_routes()                    # GATE 2: rute beku
```

## Guardrail yang ditegakkan (§2)

- **Deterministik**: input sama → output identik (uji `tests/test_acceptance.py`).
- **No fail-closed**: hapus `k-means-constrained` → tetap jalan via fallback.
- **Murni lokal**: tidak ada network di jalur logic (haversine saja).
- **GADM hanya di `core/qc.py`** — tripwire kualitas data, bukan input logic.
- **Penempatan hari murni K-Means** (clump padat per sales) — BLOCKING & TRAFFIC.

## Test

```
python -m pytest route_engine/tests -q
```

## Catatan implementasi terbuka (spec §12)

- Granularitas adjust TRAFFIC (`Plan.move_store`, tag `# TODO confirm` §4B) —
  default belum dikonfirmasi user.
- `balance_criterion = ROUTE_LENGTH`: enum + `load_score` sudah disiapkan;
  pemotongan penuh menyusul. v1 memotong by COUNT.
- `tier` / `service_weight`: jalur disediakan di `Store` + `load_score`, belum
  diimplementasi.
```
