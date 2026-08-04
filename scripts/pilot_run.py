"""
pilot_run.py — Jalankan engine atas data distributor LAIN, sepenuhnya OFFLINE.

Dipakai untuk "tes distributor kedua": membuktikan engine menghasilkan plan yang
berguna untuk data di luar Nabati, SEBELUM ada kode platform apa pun ditulis.

KENAPA OFFLINE TOTAL — bukan lewat aplikasi:
  upsert_stores menolak area_id yang tidak ada di mst_area.areas (0003:373), dan
  mst_area adalah master data milik nabati-heroes. Memuat data distributor lain
  lewat aplikasi berarti menyisipkan area palsu ke bagan organisasi perusahaan
  lain. Skrip ini tidak menyentuh DB sama sekali: CSV masuk, HTML + CSV keluar.
  Nol kredensial, nol jaringan, nol jejak.

Pakai:
    python scripts/pilot_run.py --csv data.csv --depo-lat -6.2 --depo-lon 106.8 --sales 5

Keluaran (di --out, default: pilot_out/):
    plan.html          visualizer mandiri, BLOCKING vs TRAFFIC berdampingan
    assignments_*.csv  satu baris per toko — bisa dibuka di Excel oleh calon user
    ringkasan dicetak ke layar

Fail-loud: baris cacat DILAPORKAN dan menggagalkan run, tidak dilewati diam-diam.
Sama seperti engine — lebih baik berhenti terlihat daripada menyimpang senyap.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

# Konsol Windows default cp1252 -> karakter non-ASCII bikin UnicodeEncodeError dan
# skrip mati SEBELUM mencetak hasil. Calon pengguna akan menjalankan ini di mesin
# mereka sendiri; jangan sampai gagal karena tanda panah.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from route_engine.engine import RouteEngine                      # noqa: E402
from route_engine.models import (                                # noqa: E402
    BalanceCriterion, Cycle, PlanConfig, Philosophy, Store, VisitFrequency,
)
from route_engine.viz import render_plans_html                   # noqa: E402


# ── Kontrak kolom ─────────────────────────────────────────────────────────────
# Alias SENGAJA disamakan dengan src/pages/UploadTokoPage.tsx (COLUMN_ALIASES)
# supaya file yang lolos di sini juga lolos di aplikasi nanti — satu kontrak,
# bukan dua yang perlahan menyimpang.
ALIASES = {
    "customer_code": "customer_code", "kode": "customer_code", "code": "customer_code",
    "customer_name": "customer_name", "nama": "customer_name", "name": "customer_name",
    "toko": "customer_name",
    "latitude": "latitude", "lat": "latitude",
    "longitude": "longitude", "lon": "longitude", "lng": "longitude",
    "div_sls": "div_sls", "divisi": "div_sls", "division": "div_sls",
    "type": "type", "tier": "type", "tipe": "type",
    "omset": "omset", "omzet": "omset",
    # TIDAK ada di UploadTokoPage -- lihat catatan di docs/pilot/README.md.
    # Engine memakainya (M2 ganjil/genap), jadi untuk pilot WAJIB bisa dikirim.
    "visit_frequency": "visit_frequency", "frekuensi": "visit_frequency",
    "kunjungan": "visit_frequency",
}

REQUIRED = ["customer_code", "customer_name", "latitude", "longitude"]

# Bound Indonesia — sama dengan UploadTokoPage.tsx:126-127. Dengan fokus FMCG
# Indonesia ini validasi yang sah, bukan keterbatasan.
LAT_MIN, LAT_MAX = -11.0, 6.0
LON_MIN, LON_MAX = 95.0, 141.0


class PilotError(SystemExit):
    """Berhenti dengan pesan yang bisa ditindaklanjuti, bukan traceback."""


def _normalize_header(name: str) -> str:
    return ALIASES.get(name.strip().lower().replace(" ", "_"), name.strip().lower())


def load_stores(csv_path: Path) -> tuple[list[Store], dict]:
    """Baca CSV → (stores, meta). Baris cacat = gagal, bukan dilewati."""
    if not csv_path.exists():
        raise PilotError(f"File tidak ditemukan: {csv_path}")

    with csv_path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise PilotError("CSV kosong — tidak ada baris header.")
        header_map = {h: _normalize_header(h) for h in reader.fieldnames}
        present = set(header_map.values())

        missing = [c for c in REQUIRED if c not in present]
        if missing:
            raise PilotError(
                f"Kolom wajib tidak ditemukan: {', '.join(missing)}\n"
                f"Header terbaca: {', '.join(reader.fieldnames)}\n"
                f"Lihat docs/pilot/template_toko.csv untuk contoh."
            )

        rows = [{header_map[k]: v for k, v in raw.items()} for raw in reader]

    if not rows:
        raise PilotError("CSV hanya berisi header, tidak ada data toko.")

    stores: list[Store] = []
    errors: list[str] = []
    seen: set[str] = set()
    freq_counter: Counter = Counter()

    for i, r in enumerate(rows, start=2):   # 2 = baris pertama setelah header
        code = (r.get("customer_code") or "").strip()
        name = (r.get("customer_name") or "").strip()
        if not code:
            errors.append(f"baris {i}: customer_code kosong")
            continue
        if code in seen:
            errors.append(f"baris {i}: customer_code '{code}' duplikat")
            continue

        try:
            lat = float(str(r.get("latitude", "")).strip())
            lon = float(str(r.get("longitude", "")).strip())
        except ValueError:
            errors.append(f"baris {i} ({code}): latitude/longitude bukan angka")
            continue

        if not (LAT_MIN <= lat <= LAT_MAX):
            errors.append(f"baris {i} ({code}): latitude {lat} di luar Indonesia ({LAT_MIN}..{LAT_MAX})")
            continue
        if not (LON_MIN <= lon <= LON_MAX):
            errors.append(f"baris {i} ({code}): longitude {lon} di luar Indonesia ({LON_MIN}..{LON_MAX})")
            continue

        raw_freq = (r.get("visit_frequency") or "").strip().upper()
        if raw_freq in ("WEEKLY", "W", "MINGGUAN"):
            freq = VisitFrequency.WEEKLY
        elif raw_freq in ("BIWEEKLY", "B", "2 MINGGUAN", "DUA MINGGUAN", ""):
            freq = VisitFrequency.BIWEEKLY
        else:
            errors.append(
                f"baris {i} ({code}): visit_frequency '{raw_freq}' tidak dikenal "
                f"(pakai WEEKLY atau BIWEEKLY)"
            )
            continue
        freq_counter[freq.value] += 1

        seen.add(code)
        stores.append(Store(
            customer_code   = code,
            latitude        = lat,
            longitude       = lon,
            visit_frequency = freq,
            tier            = (r.get("type") or "").strip() or None,
        ))

    if errors:
        shown = "\n  ".join(errors[:25])
        more = f"\n  ... dan {len(errors) - 25} baris lain" if len(errors) > 25 else ""
        raise PilotError(
            f"{len(errors)} baris bermasalah — diperbaiki dulu, jangan dijalankan sebagian:\n"
            f"  {shown}{more}"
        )

    divisions = Counter(
        (r.get("div_sls") or "").strip() for r in rows if (r.get("div_sls") or "").strip()
    )
    meta = {
        "total_rows": len(rows),
        "divisions": divisions,
        "freq": freq_counter,
        "has_freq_column": "visit_frequency" in present,
    }
    return stores, meta


def filter_division(stores, rows_div: dict, div: str | None, divisions: Counter):
    """Engine berjalan per divisi. Mencampur divisi = plan yang salah secara diam-diam."""
    if not divisions:
        return stores
    if div is None:
        raise PilotError(
            f"Data punya {len(divisions)} divisi: {', '.join(sorted(divisions))}\n"
            f"Engine merencanakan SATU divisi per run (armada sales berbeda per divisi).\n"
            f"Jalankan ulang dengan --div <nama>, sekali untuk tiap divisi."
        )
    if div not in divisions:
        raise PilotError(f"Divisi '{div}' tidak ada. Yang tersedia: {', '.join(sorted(divisions))}")
    keep = {c for c, d in rows_div.items() if d == div}
    return [s for s in stores if s.customer_code in keep]


def summarize(label: str, plan) -> None:
    per_sales = plan.summary["per_sales"]
    imb = plan.summary["imbalance"]
    counts = [p["count"] for p in per_sales]
    print(f"\n  {label}")
    print(f"    sales           : {len(per_sales)}")
    print(f"    toko/sales      : min {min(counts)}  max {max(counts)}  "
          f"(sebar {imb['count_spread_pct']}%)")
    print(f"    est. panjang rute: sebar {imb['est_length_spread_pct']}%")
    if plan.summary["qc_flags"]:
        print(f"    QC flag         : {len(plan.summary['qc_flags'])} toko ditandai")


def write_assignments(plan, path: Path) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["customer_code", "sales", "hari", "urutan", "pekan_ganjil", "pekan_genap", "qc_flag"])
        for a in sorted(plan.assignments, key=lambda x: (x.sales_person_name, x.day_index, x.visit_order)):
            w.writerow([
                a.customer_code, a.sales_person_name, a.day_of_week,
                a.visit_order, a.visit_ganjil, a.visit_genap, a.qc_flag or "",
            ])


def main() -> None:
    ap = argparse.ArgumentParser(description="Jalankan engine atas data distributor lain (offline).")
    ap.add_argument("--csv", required=True, type=Path, help="File CSV data toko")
    ap.add_argument("--depo-lat", required=True, type=float)
    ap.add_argument("--depo-lon", required=True, type=float)
    ap.add_argument("--sales", required=True, type=int, help="Jumlah salesman yang tersedia")
    ap.add_argument("--days", default=6, type=int, help="Hari kerja per pekan (default 6)")
    ap.add_argument("--cycle", default="M2", choices=["M1", "M2"],
                    help="M1 = tiap pekan; M2 = ganjil/genap (default M2)")
    ap.add_argument("--div", default=None, help="Divisi yang direncanakan (wajib bila data multi-divisi)")
    ap.add_argument("--out", default=Path("pilot_out"), type=Path)
    args = ap.parse_args()

    if not (LAT_MIN <= args.depo_lat <= LAT_MAX and LON_MIN <= args.depo_lon <= LON_MAX):
        raise PilotError(f"Koordinat depo di luar Indonesia: {args.depo_lat}, {args.depo_lon}")

    stores, meta = load_stores(args.csv)

    # Peta code→divisi untuk filter (dibaca ulang agar load_stores tetap murni).
    rows_div: dict[str, str] = {}
    if meta["divisions"]:
        with args.csv.open(encoding="utf-8-sig", newline="") as fh:
            rd = csv.DictReader(fh)
            hm = {h: _normalize_header(h) for h in (rd.fieldnames or [])}
            for raw in rd:
                r = {hm[k]: v for k, v in raw.items()}
                rows_div[(r.get("customer_code") or "").strip()] = (r.get("div_sls") or "").strip()

    stores = filter_division(stores, rows_div, args.div, meta["divisions"])

    # Frekuensi dihitung ULANG setelah filter divisi -- angka sebelum filter
    # menghitung toko divisi lain dan menyesatkan pembaca laporan.
    freq_in_scope = Counter(s.visit_frequency.value for s in stores)

    print(f"Terbaca  : {meta['total_rows']} baris, semua valid")
    if meta["divisions"]:
        print(f"Divisi   : {args.div} -> {len(stores)} toko "
              f"(dari {len(meta['divisions'])} divisi: {', '.join(sorted(meta['divisions']))})")
    else:
        print(f"Toko     : {len(stores)}")
    print(f"Frekuensi: {dict(freq_in_scope)}")
    if not meta["has_freq_column"]:
        print("  [!] kolom visit_frequency TIDAK ADA -> semua toko dianggap BIWEEKLY.")
        print("    Kalau distributor ini punya toko mingguan, hasilnya akan salah. Lihat docs/pilot/README.md.")
    if len(stores) < args.sales:
        raise PilotError(f"Toko ({len(stores)}) lebih sedikit dari sales ({args.sales}) — periksa lagi angkanya.")

    engine = RouteEngine()
    plans = {}
    for philosophy in (Philosophy.BLOCKING, Philosophy.TRAFFIC):
        cfg = PlanConfig(
            n_sales=args.sales,
            depo_lat=args.depo_lat,
            depo_lon=args.depo_lon,
            work_days=args.days,
            cycle=Cycle(args.cycle),
            philosophy=philosophy,
            balance_criterion=BalanceCriterion.COUNT,
            depo_id="PILOT",
            base_name=args.div or "SLS",
        )
        plans[philosophy.value] = engine.run(stores, cfg, plan_id=f"pilot-{philosophy.value}")

    args.out.mkdir(parents=True, exist_ok=True)
    for label, plan in plans.items():
        summarize(label, plan)
        write_assignments(plan, args.out / f"assignments_{label}.csv")

    html = render_plans_html(plans, str(args.out / "plan.html"))
    print(f"\nHasil:\n  {html}\n  {args.out / 'assignments_BLOCKING.csv'}"
          f"\n  {args.out / 'assignments_TRAFFIC.csv'}")
    print("\nBuka plan.html di browser — mandiri, tanpa internet.")


if __name__ == "__main__":
    main()
