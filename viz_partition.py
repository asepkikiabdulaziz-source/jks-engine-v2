"""
viz_partition.py — Visualisasi perbandingan 3 algoritma partisi sales
Jalankan: python viz_partition.py
"""
import math
import random
from collections import defaultdict

# ── Generate toko realistis (distribusi tidak merata) ─────────────────────────
# Simulasi: 3 klaster padat (kota kecil) + sebaran tipis di pinggir

def make_stores(n_total=120, seed=42):
    rng = random.Random(seed)
    stores = []
    # Klaster A: padat di barat laut
    for _ in range(n_total // 3):
        stores.append((
            -7.90 + rng.gauss(0, 0.06),
            112.60 + rng.gauss(0, 0.05),
        ))
    # Klaster B: padat di timur
    for _ in range(n_total // 3):
        stores.append((
            -7.95 + rng.gauss(0, 0.05),
            112.85 + rng.gauss(0, 0.04),
        ))
    # Sisa: tersebar di tengah/selatan (tipis)
    for _ in range(n_total - 2 * (n_total // 3)):
        stores.append((
            -8.05 + rng.gauss(0, 0.12),
            112.72 + rng.gauss(0, 0.10),
        ))
    # Tambah kode unik
    return [{"code": f"C{i:04d}", "lat": lat, "lon": lon}
            for i, (lat, lon) in enumerate(stores)]


# ── Algoritma 1: slice_by_bearing ─────────────────────────────────────────────
def bearing(lat1, lon1, lat2, lon2):
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(rlat2)
    x = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

def centroid(stores):
    return (
        sum(s["lat"] for s in stores) / len(stores),
        sum(s["lon"] for s in stores) / len(stores),
    )

def slice_by_bearing(stores, n):
    clat, clon = centroid(stores)
    ordered = sorted(stores, key=lambda s: (bearing(clat, clon, s["lat"], s["lon"]), s["code"]))
    base, rem = divmod(len(ordered), n)
    sizes = [base + (1 if i < rem else 0) for i in range(n)]
    labels, pos = {}, 0
    for idx, sz in enumerate(sizes):
        for _ in range(sz):
            labels[ordered[pos]["code"]] = idx
            pos += 1
    return labels


# ── Algoritma 2: KMeansConstrained ───────────────────────────────────────────
def kmeans_constrained(stores, n, tolerance=0.10):
    try:
        import numpy as np
        from k_means_constrained import KMeansConstrained as KMC
        X = np.array([[s["lat"], s["lon"]] for s in stores])
        avg = len(stores) / n
        size_min = max(1, int(math.floor(avg * (1 - tolerance))))
        size_max = int(math.ceil(avg * (1 + tolerance)))
        raw = KMC(n_clusters=n, size_min=size_min, size_max=size_max, random_state=42).fit_predict(X)
        return {stores[i]["code"]: int(raw[i]) for i in range(len(stores))}
    except Exception as e:
        print(f"  KMeansConstrained gagal ({e}), fallback ke slice_by_bearing")
        return slice_by_bearing(stores, n)


# ── Algoritma 3: Recursive Median Bisection ───────────────────────────────────
def recursive_bisection(stores, n):
    """
    Potong di median sepanjang axis terpanjang, rekursif sampai N kelompok.
    Pure Python. Kompak, balance by count.
    """
    def bisect(items, k, label_start):
        if k == 1:
            return {s["code"]: label_start for s in items}
        # Tentukan axis terpanjang
        lat_range = max(s["lat"] for s in items) - min(s["lat"] for s in items)
        lon_range = max(s["lon"] for s in items) - min(s["lon"] for s in items)
        axis = "lat" if lat_range >= lon_range else "lon"
        sorted_items = sorted(items, key=lambda s: s[axis])
        mid = len(sorted_items) // 2
        k_left  = k // 2
        k_right = k - k_left
        left  = bisect(sorted_items[:mid],  k_left,  label_start)
        right = bisect(sorted_items[mid:],  k_right, label_start + k_left)
        return {**left, **right}
    return bisect(stores, n, 0)


# ── Visualisasi ───────────────────────────────────────────────────────────────
def plot_all(stores, n_sales=4):
    try:
        import matplotlib.pyplot as plt
        import matplotlib.patches as mpatches
    except ImportError:
        print("matplotlib tidak terinstall: pip install matplotlib")
        return

    algos = [
        ("Slice by Bearing\n(current fallback)",    slice_by_bearing(stores, n_sales)),
        ("KMeans Constrained\n(primary)",           kmeans_constrained(stores, n_sales)),
        ("Recursive Bisection\n(proposed fallback)", recursive_bisection(stores, n_sales)),
    ]

    COLORS = ["#e74c3c", "#2980b9", "#27ae60", "#f39c12", "#8e44ad", "#16a085"]
    depo   = (-8.00, 112.72)

    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    fig.suptitle(
        f"Perbandingan Algoritma Partisi — {len(stores)} toko, {n_sales} sales",
        fontsize=13, fontweight="bold", y=1.01
    )

    for ax, (title, labels) in zip(axes, algos):
        # Hitung counts per label
        counts = defaultdict(int)
        for v in labels.values():
            counts[v] += 1
        avg = len(stores) / n_sales
        spread_pct = (max(counts.values()) - min(counts.values())) / avg * 100

        # Plot stores per group
        by_group = defaultdict(list)
        for s in stores:
            by_group[labels[s["code"]]].append(s)

        for grp_idx in sorted(by_group):
            grp = by_group[grp_idx]
            lats = [s["lat"] for s in grp]
            lons = [s["lon"] for s in grp]
            ax.scatter(lons, lats,
                       c=COLORS[grp_idx % len(COLORS)],
                       s=18, alpha=0.75, edgecolors="none",
                       label=f"Sales {grp_idx+1} ({counts[grp_idx]} toko)")

        # Depo
        ax.scatter([depo[1]], [depo[0]], marker="^", s=120,
                   c="#131b2e", zorder=10, label="Depo")

        ax.set_title(
            f"{title}\nspread: {spread_pct:.0f}%  "
            f"(min {min(counts.values())} / max {max(counts.values())} toko)",
            fontsize=9
        )
        ax.set_xlabel("Longitude", fontsize=8)
        ax.set_ylabel("Latitude",  fontsize=8)
        ax.tick_params(labelsize=7)
        ax.legend(fontsize=7, loc="lower right")
        ax.set_aspect("equal")

    plt.tight_layout()
    out = "viz_partition_result.png"
    plt.savefig(out, dpi=130, bbox_inches="tight")
    print(f"Saved: {out}")
    plt.show()


# ── Cetak tabel counts ────────────────────────────────────────────────────────
def print_table(stores, n_sales=4):
    sep = "=" * 55
    mid = "-" * 55
    print(f"\n{sep}")
    print(f"{'':20s} {'min':>5} {'max':>5} {'spread':>8}")
    print(mid)
    for name, fn in [
        ("Slice by Bearing",     lambda: slice_by_bearing(stores, n_sales)),
        ("KMeans Constrained",   lambda: kmeans_constrained(stores, n_sales)),
        ("Recursive Bisection",  lambda: recursive_bisection(stores, n_sales)),
    ]:
        labels = fn()
        counts = defaultdict(int)
        for v in labels.values():
            counts[v] += 1
        avg = len(stores) / n_sales
        spread = (max(counts.values()) - min(counts.values())) / avg * 100
        print(f"{name:20s}  {min(counts.values()):>5}  {max(counts.values()):>5}  {spread:>6.1f}%")
    print(f"{sep}\n")


if __name__ == "__main__":
    stores  = make_stores(120)
    n_sales = 4
    print(f"Stores: {len(stores)}, Sales: {n_sales}")
    print_table(stores, n_sales)
    plot_all(stores, n_sales)
