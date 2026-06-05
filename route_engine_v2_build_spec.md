# JKS Route Engine v2 — Build Spec (Handoff ke Coding Agent)

> Dokumen ini adalah **instruksi build yang mengikat**, bukan deskripsi longgar.
> Penjelasan dalam Bahasa Indonesia; identifier kode dalam Bahasa Inggris (ikuti gaya kode lama: `customer_code`, `visit_order`, dst).
> Kalau ada keputusan implementasi yang ragu, **kembali ke Bagian 2 (Prinsip Non-Negosiabel)** — itu juri terakhir.

---

## 1. Apa yang dibangun (dan yang TIDAK)

Engine ini adalah **penimbang & perekomendasi** untuk desain teritori dan jadwal kunjungan salesman. **Bukan pemutus.** Manusia (area manager) yang memutuskan; engine merekomendasi, menghitung beban, dan menandai masalah.

**IN SCOPE**

- QC data koordinat (surface masalah, bukan auto-fix)
- Partisi toko ke N sales (draft, untuk digeser manusia)
- Dua filosofi penjadwalan hari: `BLOCKING` dan `TRAFFIC`
- Pola 6×2 (6 hari kerja × ganjil/genap untuk siklus M2)
- Estimator beban murah (cacah toko + estimasi panjang rute)
- Summary as-is → to-be per sales dan per hari
- Locking bertahap + versioning plan

**OUT OF SCOPE — JANGAN DIBANGUN SEKARANG**

- VRP constraint penuh, time windows, kapasitas kendaraan
- Turn-by-turn / navigasi
- Pemanggilan server routing publik (OSRM dsb) — **dilarang** (alasan: reliabilitas)
- Optimasi rute presisi → ditunda ke OR-Tools atau aplikasi SFA di HP sales

Sequencing yang kita hitung di sini **hanya** untuk menimbang beban, bukan untuk dijadikan rute final yang dioptimalkan.

---

## 2. Prinsip Non-Negosiabel (guardrail)

1. **Engine merekomendasi, manusia memutuskan.** Tidak ada output yang terkunci tanpa aksi manusia. Tidak ada auto-resolve untuk edge case — semua di-surface ke manusia.
2. **Reliability > capability.** Setiap langkah algoritmik WAJIB punya fallback deterministik. **Tidak boleh ada dependency yang fail-closed** (crash kalau library tidak ada). Kalau `k-means-constrained` absen, engine tetap jalan via fallback, hanya kualitas turun.
3. **Deterministik.** `random_state` tetap. Input sama → output sama, persis. Ini soal kepercayaan manusia terhadap tool.
4. **Murni lokal.** Semua jarak pakai haversine. Tidak ada network call di jalur logic.
5. **GADM hanya untuk QC.** Label administratif dari reverse-lookup koordinat **tidak pernah** masuk ke logic partisi atau penjadwalan. Ia tripwire kualitas data, titik.
6. **Metrik beban pluggable.** v1 memotong pakai **cacah toko**, TAPI **estimasi panjang rute selalu ikut ditampilkan** di summary. Kriteria potong adalah `enum` yang bisa di-flip tanpa rombak struktur.
7. **"Berurutan melingkar" untuk hari = jaminan by-construction**, bukan harapan. Diperoleh dengan memotong dari urutan bearing yang sudah ter-sort, bukan dengan post-processing.

---

## 3. Kontrak Data

### Input toko (yang nyata kita punya hari ini)
```
customer_code : str   # unik, deduplikasi wajib
latitude      : float
longitude     : float
```

### Atribut turunan / manual
```
gadm_region     : str   # hasil reverse-lookup — DIPAKAI HANYA DI QC
visit_frequency : enum {BIWEEKLY, WEEKLY}  # default BIWEEKLY; di-set MANUAL oleh manusia saat adjustment
                                            # (data tidak menyediakan ini; jangan ditebak engine)
tier            : optional  # belum ada datanya. Sediakan jalurnya, jangan implementasi sekarang.
```

### Config plan
```
n_sales          : int
work_days        : int    = 6
cycle            : enum {M1, M2}
philosophy       : enum {BLOCKING, TRAFFIC}
balance_criterion: enum {COUNT, ROUTE_LENGTH}     = COUNT      # v1 = COUNT
traffic_center   : enum {DEPO, GLOBAL_CENTROID}   = DEPO       # hanya relevan untuk TRAFFIC
depo_lat, depo_lon : float
road_factor      : float  = 1.3   # pengali haversine→estimasi jalan, untuk display saja
```

> **Future-proofing wajib:** beban dihitung lewat **satu fungsi `load_score(store_subset)`**. v1 mengembalikan `(count, est_route_length)`. Saat `tier`/`service_weight` tersedia nanti, cukup ubah fungsi ini — tidak menyentuh logic lain. Ini realisasi janji "keadilan palsu → keadilan nyata tanpa rombak".

---

## 4. Pipeline & Gate Manusia

Dua filosofi punya **struktur gate yang berbeda** — jangan dipaksa seragam.

### 4A. BLOCKING (sales-first)
```
Stage 0  QC
Stage 1  Partisi N sales (DRAFT)           ← engine merekomendasi
─────────  GATE 1: manusia geser toko ANTAR-SALES di peta → LOCK TERRITORY
Stage 2  Per sales: iris 6 hari (centroid sales) → 6×2
─────────  GATE 2: manusia geser toko ANTAR-HARI / ANTAR-PEKAN, hanya dalam SALES yang sama → LOCK ROUTES
Stage 3  Output + Summary + version_id
```
Setelah LOCK TERRITORY, pemilik toko (sales) **beku**. Edit di Gate 2 **tidak boleh** memindah toko lintas sales, dan **tidak boleh** me-regenerate hari lain (lihat §7).

### 4B. TRAFFIC (day-first)
```
Stage 0  QC
Stage 1  Iris 6 hari GLOBAL (center = depo / global centroid)
Stage 2  Di tiap hari: partisi N sales (balanced) → 6×2
─────────  GATE: manusia adjust → LOCK
Stage 3  Output + Summary + version_id
```
Di TRAFFIC **tidak ada kepemilikan wilayah** (trade-off yang sudah diterima). Karena itu tidak ada "lock territory" terpisah.

> **KEPUTUSAN TERBUKA (default, konfirmasi ke user):** granularitas adjust di TRAFFIC = pindah toko **antar-sales dalam hari yang sama** dan **antar-pekan**. Satu lock tunggal setelah 6×2 terbentuk. Tandai di kode sebagai `# TODO confirm`.

---

## 5. Stage 0 — QC (surface, jangan auto-fix)

Modul `core/qc.py`. Engine tetap melanjutkan dengan **semua** data; flag dibawa terus dan ditampilkan.

1. **`gross_outlier_check`** — pakai `gadm_region`. Flag toko yang region-nya melenceng jauh dari mayoritas / dari region yang diharapkan plan. (Contoh: koordinat Lumajang ter-resolve ke Banten → hampir pasti salah input.)
2. **`stacked_coordinate_check`** — yang **tidak bisa** ditangkap GADM dan justru merusak metrik jarak:
   - koordinat duplikat persis (banyak toko share lat/lon identik → indikasi isian centroid kelurahan / entri malas)
   - tumpukan rapat tidak wajar (≥ K toko dalam radius sangat kecil, mis. < 10 m)

Output: `qc_flags: list[{customer_code, reason}]`. **Tidak menghentikan pipeline.**

---

## 6. Stage Partisi & Penjadwalan — Algoritma Inti

### 6.1 Util bersama: `slice_by_bearing(stores, center, n_slices) -> labels`
Inti dari jaminan "berurutan melingkar".
```
1. bearing_i = bearing(center, store_i)          # 0..360, dari core/geo.py
2. order = argsort(bearing_i)                      # urutkan menaik
3. potong `order` jadi n_slices chunk EQUAL-COUNT  # kerataan JUMLAH (keputusan user)
4. label tiap chunk 0..n_slices-1 sesuai urutan
```
Karena dipotong dari urutan sudut menaik, chunk pasti berurutan melingkar (hari 1–2 bersebelahan, … , hari terakhir menutup balik ke hari 1) **by construction**. Lebar sudut tiap chunk boleh beda; jumlah toko-nya yang dibuat sama.

> Catatan: kalau nanti `balance_criterion = ROUTE_LENGTH`, ganti aturan potong dari "equal-count" jadi "equal estimated-length". Struktur tetap.

### 6.2 Partisi sales (`core/partition.py`): `balanced_partition(stores, n, criterion)`
Tujuan: N klaster kompak, seimbang (v1 by COUNT), deterministik. **Ini DRAFT untuk digeser manusia, bukan keputusan final.**
- Boleh pakai constrained balanced clustering (mis. `KMeansConstrained`) untuk draft.
- **WAJIB fallback** bila library absen ATAU hasil melanggar bounds: fallback = `slice_by_bearing` dari centroid global, potong jadi N. Jangan crash.
- Output: `{customer_code -> sales_index}`.

### 6.3 BLOCKING — penjadwalan hari
Untuk tiap `sales` (assignment sudah beku dari Gate 1):
```
center_sales = centroid(stores_of_sales)
day_label    = slice_by_bearing(stores_of_sales, center_sales, work_days)
```
→ tiap hari = irisan pai wilayah sales itu; salesman menyapu mengelilingi pusat wilayahnya sendiri; kesinambungan per-sales terjaga.

### 6.4 TRAFFIC — penjadwalan hari
```
center_global = depo  if traffic_center == DEPO  else centroid(all_stores)
day_label     = slice_by_bearing(all_stores, center_global, work_days)   # 6 sudut GLOBAL
# lalu di tiap hari:
for each day:
    sales_label_in_day = balanced_partition(stores_of_day, n_sales, COUNT)
```
→ semua sales berbagi sudut yang sama tiap hari (memungkinkan berbagi armada). Default center = depo (paling setia ke tujuan "berangkat bareng dari gudang"); sediakan toggle ke global centroid untuk kasus depo-di-pinggir.

### 6.5 Pola 6×2 — ganjil/genap (`core/biweekly.py`)
Hanya jika `cycle == M2`. Untuk tiap blok (hari, sales):
```
1. urutkan toko blok itu dengan estimator NN-tour (core/estimator.py)
2. assign berselang-seling sepanjang urutan tur:
      index genap → ganjil = True
      index ganjil → genap = True
3. toko dengan visit_frequency == WEEKLY → ganjil = True AND genap = True
```
**Penting:** jangan pakai 2-cluster spasial untuk membelah pekan — itu menghasilkan belah utara/selatan sehingga salesman nyetir ke ujung berlawanan tiap minggu. Selang-seling sepanjang tur menjamin **kedua pekan menjangkau sebaran geografis yang mirip** (inti keputusan "rata wilayah, bukan rata jumlah utara-selatan").

Jika `cycle == M1`: semua toko `ganjil = genap = True` (atau set sesuai konvensi field yang dipakai downstream — samakan dengan output lama).

---

## 7. Locking & Edit Lokal

- **Dua lock terpisah** (BLOCKING): `lock_territory`, `lock_routes`. TRAFFIC: satu lock.
- Setelah `lock_territory`: assignment sales beku. Edit hari **tidak** mengubah pemilik toko.
- **Edit lokal wajib lokal:** memindah/menyisipkan satu toko ke hari/pekan lain **hanya** menyentuh hari sumber & tujuan. **Dilarang** me-regenerate seluruh 6×2 sales tersebut (manajer kehilangan kerapian yang sudah ia susun → tool ditinggalkan).
- **Versioning:** tiap plan punya `version_id`. Plan sebelumnya disimpan sebagai draft/acuan redesign. Jangan overwrite destruktif.

---

## 8. Estimator Beban (`core/estimator.py`)

- `nn_tour_length(stores, start)` — panjang tur nearest-neighbor (haversine × `road_factor`). **Untuk membandingkan, bukan untuk akurat.** Yang penting konsisten antar-sales.
- `load_score(store_subset)` → `{count, est_route_length}`. Satu-satunya pintu untuk upgrade ke beban berbobot tier di masa depan.

---

## 9. Output

### Per baris assignment
```
plan_id, version_id,
customer_code, store_id,
sales_person_name,                 # format: f"{depo_id}-{base_name}-{sales_index+1:02d}"
philosophy,                        # BLOCKING | TRAFFIC
day_of_week,                       # atau day_index 1..work_days
visit_cycle,                       # M1 | M2
visit_ganjil : bool,
visit_genap  : bool,
visit_order  : int,                # urutan kunjungan dalam (hari, sales, pekan)
qc_flag      : str | null
```

### Objek summary plan (untuk UI "as-is → to-be")
```
per_sales : [{sales, count, est_route_length}]
per_day   : [{sales, day, count, est_route_length}]
qc_flags  : [{customer_code, reason}]
imbalance : ringkasan ketimpangan (mis. selisih % count & selisih % est_length antar-sales)
```
UI menampilkan **dua angka** (count DAN est_route_length) berdampingan — supaya manajer melihat ketimpangan jarak walau pemotongan v1 pakai count.

---

## 10. Struktur Modul (saran, selaras FastAPI yang ada)

```
core/geo.py         haversine, bearing, centroid   ← SALVAGE dari engine lama (math murni, sudah benar)
core/qc.py          gross_outlier_check, stacked_coordinate_check
core/partition.py   balanced_partition (+ fallback)
core/scheduling.py  slice_by_bearing, build_blocking, build_traffic
core/biweekly.py    split_ganjil_genap
core/estimator.py   nn_tour_length, load_score
core/summary.py     build_summary
engine.py           orkestrasi + schema output + versioning
```

> Dari engine lama, **hanya** `haversine`, `bearing`, dan pola 6×2 yang diselamatkan. Seluruh "otak" partisi K-means top-down lama **dibuang** — kita pakai partisi hanya sebagai draft yang digeser manusia, bukan pemutus.

---

## 11. Acceptance Checks (coding agent self-verify)

- [ ] **Determinisme:** dua run input identik → output identik byte-per-byte.
- [ ] **No fail-closed:** hapus/blokir `k-means-constrained` → engine tetap menghasilkan hasil via fallback, tanpa exception.
- [ ] **Hari berurutan melingkar:** untuk tiap unit (sales di BLOCKING / global di TRAFFIC), batas sudut antar-hari monoton; hari terakhir bertetangga dengan hari pertama.
- [ ] **Kerataan jumlah:** selisih cacah toko antar-hari dalam toleransi yang disepakati.
- [ ] **M2 spread:** tiap toko punya ganjil ATAU genap (atau keduanya bila WEEKLY); selisih sebaran geografis ganjil vs genap kecil (bukan belah utara/selatan).
- [ ] **Lock dihormati:** setelah lock_territory (BLOCKING), edit hari tidak pernah mengubah `sales_person_name`.
- [ ] **Edit lokal:** memindah 1 toko antar-hari hanya mengubah baris hari sumber & tujuan.
- [ ] **Isolasi GADM:** tidak ada referensi `gadm_region` di luar `core/qc.py`.
- [ ] **No network:** tidak ada panggilan jaringan di jalur logic.

---

## 12. Hal yang Disengaja Dibiarkan Terbuka

1. Granularitas adjust TRAFFIC (§4B) — default diusulkan, konfirmasi user.
2. Kapasitas/jumlah armada — **diabaikan** di tahap ini (trade-off diterima sadar). Berbagi armada di TRAFFIC adalah *konsekuensi yang dibaca manajer dari hasil*, bukan constraint yang dijamin engine.
3. Kriteria potong `ROUTE_LENGTH` — jalurnya disiapkan (enum + `load_score`), implementasi penuh menyusul.
