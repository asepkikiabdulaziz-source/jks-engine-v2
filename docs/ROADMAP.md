# JKS Route Engine v2 — Roadmap

> Dibuat: 2026-06-09 · Baseline: `master @ 7f24516`
> Dokumen perencanaan untuk pekerjaan berikutnya. Setiap item: tujuan, kondisi
> sekarang (berdasarkan kode/DB nyata), pendekatan, effort, ketergantungan, dan
> **keputusan terbuka** yang perlu diputuskan user.

---

## 0. Status baseline (sudah jalan)

- ✅ **Editor jadwal hari/pekan** di `s2_preview` (pindah toko antar hari & antar
  pola M1/M2C13/M2C24 dalam satu sales) + **undo/redo terpadu** untuk semua modul
  adjustment manual + **UI dropdown**. Terdeploy ke `master` (`7f24516`).
- ✅ Persistence via `schedule_override` di `/generate-plan` → `_build_from_override`.
- ✅ Engine: BLOCKING + TRAFFIC, penjadwalan hari **murni K-Means**, deterministik,
  **no-network**, fail-loud.
- ✅ Deploy: Cloud Run **deploy-dari-git** (`master` → auto build+deploy).
- ⚠️ **AUDIT C1/H1 masih terbuka** (lihat §Lintas-isu).

## Prinsip yang dijaga

- **Engine core tetap deterministik & no-network** (§2.3–2.4). Apa pun yang butuh
  jaringan (OSM/Google) = **layer enrichment terpisah**, bukan di dalam engine.
- **Engine merekomendasi, manusia memutuskan** — semua adjustment manual.
- **Verifikasi dulu, anti-kosmetik, root-cause sebelum solusi.**

---

## Ringkasan item

| # | Item | Nilai | Effort | Tergantung |
|---|------|-------|--------|-----------|
| A | Hardening editor di mode **TRAFFIC** | Cegah bug senyap | S–M | — |
| B | **Edit plan dari draft** (iterasi plan tersimpan) | Tinggi | M | — |
| C | **Edit plan dari upload** (import plan jadi) | Sedang | L | B |
| D | **Mapping ke kode sales real** (SLS-02 → kode nyata) | Tinggi (rollout) | M | — |
| E | **Optimasi rute road-aware** (OSM/Google) | Realism tertinggi | L | — |
| — | AUDIT C1/H1 (keamanan) | **WAJIB pra-trial** | S–M | — |

Effort: **S** ≈ <1 sesi, **M** ≈ 1–2 sesi, **L** ≈ 3+ sesi.

---

## A. Hardening editor di mode TRAFFIC

**Masalah (temuan analisis kode):** editor `s2_preview` (`applyMove`) dibangun dengan
asumsi **BLOCKING** — saat toko dipindah antar hari, ia **tetap di sales yang sama**
(`salesOfCode`). Tapi di **TRAFFIC**, sales = **zona hari** (day-first): "hari" itulah
yang menentukan salesman. Jadi "pindah hari" di TRAFFIC seharusnya memindahkan toko ke
**salesman pemilik hari tujuan**, bukan mempertahankan sales lama. Editor sekarang akan
menghasilkan jadwal yang **tak konsisten** dengan logika TRAFFIC.

**Risiko:** silent — editor "jalan" tapi hasil di TRAFFIC ngawur. Reassign-sales (s1)
juga sudah di-gate berbeda (di TRAFFIC, s1_done = zona hari, bukan sales).

**Pendekatan:**
- **Opsi 1 (cepat, aman):** gate editor hari/pekan **hanya BLOCKING**. Di TRAFFIC,
  sembunyikan picker + tampilkan info ("adjustment per-sales hanya untuk BLOCKING").
- **Opsi 2 (benar penuh):** definisikan semantik TRAFFIC — `applyMove` sadar-filosofi:
  pindah-hari = pindahkan ke sales/zona hari tujuan; pindah-pekan tetap dalam blok.

**Rekomendasi:** Opsi 1 lebih dulu (cegah bug). Opsi 2 hanya bila TRAFFIC dipakai serius.
**Langkah pertama:** verifikasi live perilaku editor di TRAFFIC (jalankan TRAFFIC →
s2_preview → coba pindah) untuk konfirmasi temuan ini.

**Effort:** S (Opsi 1) / M (Opsi 2).

---

## B. Edit plan dari draft (iterasi plan tersimpan)

**Tujuan:** buka plan **draft** yang sudah tersimpan → masuk mode editor (sama seperti
`s2_preview`) → review + adjustment (reassign sales, pindah hari/pekan, undo/redo) →
simpan **versi baru**.

**Kondisi sekarang (terkonfirmasi DB):**
- `plans` punya kolom **`status`** + **`approved_at`/`approved_by`** → draft vs approved.
- RPC **`approve_plan`**, **`discard_plan`**, **`next_plan_version`**, **`get_plan_assignments`** semua ADA.
- `PlanMapPage` (`/plans/:id/map`) saat ini **read-only**.
- Editor + undo/redo + `schedule_override` **sudah ada** → ~90% infrastruktur siap.

**Pendekatan:**
1. Load `get_plan_assignments(plan_id)` → **rekonstruksi**:
   - `territories` = group by `sales_person_name` → customer_codes.
   - `schedule` = group by (sales, hari) + pisah ganjil/genap (visit_ganjil/genap).
2. Mount editor (komponen `s2_preview` yang sama) di `PlanMapPage` untuk plan **draft**.
3. Simpan = `next_plan_version` + `save_plan` (atau `schedule_override` path).

**Keputusan terbuka:**
- Plan **approved** → read-only (tak bisa diedit) atau bisa "buka kembali ke draft"?
- Tiap edit → **versi baru** (aman, jejak audit) atau in-place untuk draft?

**Effort:** M. **Nilai tinggi** — membuat plan benar-benar iteratif (item pending lama
`/plans/:planId/map` adjustment).

---

## C. Edit plan dari upload (import plan jadi)

**Tujuan:** user **upload plan yang sudah jadi** (mis. dari Excel manual / sistem lama)
→ parse → load ke editor → review + adjustment → simpan sebagai plan baru.

**Kondisi sekarang:** ada pola **upload toko** (`stage_stores` + panel anomali di
`UploadTokoPage`) — pola ingest + validasi sudah dikenal. Belum ada **upload PLAN**.

**Pendekatan:**
1. Definisikan **format** (CSV/XLSX): minimal `customer_code, kode_sales, hari,
   pola_pekan (M1/M2C13/M2C24)`.
2. Parser + **validasi keras**: toko ∈ area, kode sales dikenal, hari valid, frekuensi
   pola cocok dengan `visit_frequency` toko → panel anomali (seperti UploadToko).
3. Map ke struktur internal `{territories, schedule}` → masuk **editor (reuse B)**.

**Risiko:** data kotor (kode toko tak match area, salesman asing) → butuh penanganan
baris-invalid yang jelas (skip + laporkan, jangan diam-diam).

**Keputusan terbuka:** format kolom final; sumber kode sales (slot internal vs kode
real, lihat D); apa yang dilakukan untuk baris invalid.

**Effort:** L. **Tergantung B** (mesin editor-atas-plan-termuat).

---

## D. Mapping ke kode sales real (SLS-02 → kode nyata)

**Tujuan:** petakan slot engine (`{kd_dist}-{div_sls}-{nn}` → tampil `SLS-02`) ke
**salesman real** (kode + nama), dipakai di tampilan, export, dan opsional di assignments.

**Kondisi sekarang (temuan DB — penting):** **infrastruktur salesman sudah ada**:
`get_salesman_slots`, `get_salesman_slot_info`, `get_salesman_supervisor_map`,
`resolve_salesman_email(_v2)`, `sync_salesman_targets`. Jadi konsep **"slot"** sudah
nyata di DB — penamaan `{kd_dist}-{div_sls}-{nn}` kemungkinan **sudah merujuk slot**.
→ Ini **bukan bangun dari nol**, lebih ke **menyambungkan** yang sudah ada.

**Langkah 1 (audit):** periksa apa yang dikembalikan `get_salesman_slots` /
`get_salesman_slot_info` — apakah mapping slot→salesman sudah otomatis? Bila ya, D
sebagian besar = wiring resolve di tampilan/export.

**Pendekatan:**
- **Resolve saat baca** (rekomendasi): `salesLabel()` & export memetakan slot → nama/kode
  real via RPC slot. Fleksibel — ganti salesman tanpa re-save plan.
- UI mapping ringan (SLS-01 → pilih salesman dari dropdown slot) bila perlu override.

**Keputusan terbuka:**
- **Resolve-saat-baca** (fleksibel) vs **tulis kode real ke `plan_assignments`** saat
  save (beku, tapi jejak jelas)?
- Apakah slot sudah auto-map ke salesman, atau perlu UI assign manual?

**Effort:** M (mungkin lebih kecil karena infra ada). **Prioritas tinggi bila rollout
lapangan dekat** — placeholder `SLS-02` tak berguna untuk supervisor/sales nyata.

---

## E. Optimasi rute road-aware (OSM / Google)

**Masalah (sudah diidentifikasi user):** `visit_order` sekarang dari `nn_tour` pakai
**haversine (garis lurus)**, bukan jaringan jalan → urutan "**menipu**". Optimasi jujur
butuh jaringan jalan nyata.

**Prinsip arsitektur:** **engine core TETAP no-network.** OSM/Google = **layer enrichment
terpisah** — dijalankan **setelah** plan dibentuk (saat simpan atau on-demand saat lihat
rute satu sales-hari). Tidak masuk `route_engine/` pure.

**Opsi:**
| Opsi | Biaya | Akurasi | Catatan |
|------|-------|---------|---------|
| **OSRM self-host** (Docker + peta OSM Indonesia) | **Gratis** | Jarak/durasi jalan, endpoint `/trip` = solver TSP urutan optimal | Perlu hosting (~beberapa GB peta, 1 container). **Rekomendasi.** |
| **Google Routes / Distance Matrix** | **Berbayar/req** | Tertinggi (+ traffic real-time) | Rate limit + ToS caching. Mahal utk 1552 toko × banyak blok. |
| GraphHopper / Valhalla | Gratis (self-host) | Setara OSRM | Alternatif. |

**Arsitektur usulan:**
- Hitung per blok **(sales, hari)** ~50 toko → **1 panggilan `trip`** per blok. ~30 blok
  per plan → murah dengan OSRM self-host.
- **Cache matriks jarak** per area (pasangan toko) agar tak hitung ulang tiap versi.
- Update `visit_order` (dan opsional estimasi durasi/jarak harian) dari hasil OSRM.

**Keputusan terbuka:**
- **OSRM self-host** (rekomendasi) vs **Google**?
- Hitung **saat save** (semua blok) vs **on-demand** (saat user buka rute satu sales-hari)?
- Hosting OSRM di mana (Cloud Run sidecar? VM terpisah?)?

**Effort:** L. **Nilai realism tertinggi**, paling **independen** — bisa dikerjakan kapan
saja tanpa blokir item lain.

---

## Lintas-isu — WAJIB sebelum trial luas

- **C1 — Otorisasi per-area di API.** Saat ini siapa pun dengan JWT valid bisa akses
  area **mana pun**. Tambah cek: user hanya boleh area yang jadi haknya (`access_roles`).
- **H1 — Validasi engine secret.** `X-Engine-Secret`/`ROUTE_ENGINE_SECRET` belum
  divalidasi.
- → **Perbaiki sebelum membuka trial ke banyak user.** Sampai itu, trial wajib tertutup.

---

## Urutan disarankan + rasional

> Catatan: urutan ini **beda** dari urutan kamu menyebut item — silakan timpa sesuai
> prioritas bisnis. Rasional di bawah.

- **Fase 0 — Hardening (sekarang):** **A (gate TRAFFIC)** + **C1/H1**. Kecil tapi
  mencegah bug senyap + mengamankan pra-trial. Tak menunda apa pun.
- **Fase 1 — Iterasi plan:** **B (edit draft)**. Reuse editor yang baru jadi, nilai
  tinggi (plan jadi benar-benar bisa diolah ulang).
- **Fase 2 — Siap lapangan:** **D (kode sales real)**. Infra DB sudah ada; wajib agar
  output dipahami sales/supervisor nyata. *(Naikkan ke Fase 1 bila rollout sudah dekat.)*
- **Fase 3 — Import:** **C (upload plan)**. Tergantung mesin editor dari B.
- **Fase 4 — Realism:** **E (OSM)**. Capstone, independen, terbesar; bisa diselipkan
  kapan saja bila ada kapasitas.

---

## Keputusan terbuka (ringkasan — butuh user)

1. **TRAFFIC:** gate-saja (Opsi 1) atau definisikan semantik penuh (Opsi 2)?
2. **Edit draft:** plan approved read-only? Tiap edit jadi versi baru?
3. **Mapping sales:** resolve-saat-baca vs simpan-kode-real? (audit `get_salesman_slots` dulu)
4. **OSM:** OSRM self-host (rekomendasi) vs Google? Saat-save vs on-demand? Hosting di mana?
5. **Import:** format kolom + sumber kode sales?
6. **Prioritas:** setuju urutan fase di atas, atau naikkan D (kode sales real) lebih awal?
