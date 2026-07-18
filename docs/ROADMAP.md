# JKS Route Engine v2 — Roadmap

> Dibuat: 2026-06-09 · Baseline: `master @ 475cda4` · Diperbarui: sesi 11 (A ✅ selesai, §F ditambah)
> Dokumen perencanaan untuk pekerjaan berikutnya. Setiap item: tujuan, kondisi
> sekarang (berdasarkan kode/DB nyata), pendekatan, effort, ketergantungan, dan
> **keputusan terbuka** yang perlu diputuskan user.

---

## 0. Status baseline (sudah jalan)

- ✅ **Editor jadwal hari/pekan** di `s2_preview` (pindah toko antar hari & antar
  pola M1/M2C13/M2C24 dalam satu sales) + **undo/redo terpadu** untuk semua modul
  adjustment manual + **UI dropdown**. Terdeploy ke `master`.
- ✅ **Adjustment sadar-filosofi** (item A, Opsi 2): TRAFFIC s1=pindah zona-hari,
  s2=pindah sales+pekan; BLOCKING s1=pindah sales, s2=pindah hari+pekan. Popup toko
  tampil **sales aktual + pola**. **Terbukti persist via DB plan V6.**
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
- **Engine = perencana dari-0, bukan optimizer operasi berjalan.** v1 mengoptimasi
  *keterbacaan + balance wajar + compactness* dari data minimal. Penyempurnaan objektif
  (beban berbobot, kapasitas waktu, rute jalan) **ditunda sadar** ke fase berdata:
  menambahkannya tanpa durasi-kunjungan/travel nyata = presisi semu (kosmetik).
  Detail & rasional: **§F**.

---

## Ringkasan item

| # | Item | Nilai | Effort | Tergantung |
|---|------|-------|--------|-----------|
| A | ✅ **SELESAI** — adjustment TRAFFIC sadar-filosofi (Opsi 2), terbukti V6 | Cegah bug senyap | ✅ | — |
| B | **Edit plan dari draft** (iterasi plan tersimpan) | Tinggi | M | — |
| C | **Edit plan dari upload** (import plan jadi) | Sedang | L | B |
| D | **Mapping ke kode sales real** (SLS-02 → kode nyata) | Tinggi (rollout) | M | — |
| E | **Optimasi rute road-aware** (OSM/Google) | Realism tertinggi | L | — |
| F | **Filosofi objektif engine** (balance/pekan/kapasitas) — keputusan & penundaan | Dokumentasi | — | E + data |
| — | AUDIT C1/H1 (keamanan) | **WAJIB pra-trial** | S–M | — |

Effort: **S** ≈ <1 sesi, **M** ≈ 1–2 sesi, **L** ≈ 3+ sesi.

---

## A. Hardening editor di mode TRAFFIC — ✅ SELESAI (Opsi 2)

**Status (sesi 11):** selesai via **Opsi 2 (semantik penuh)**, bukan gate. `applyMove` +
`S2MovePicker` kini **sadar-filosofi**:
- **TRAFFIC:** s1 = pindah **zona-hari**; s2 = pindah **sales** (hari sama) + pekan.
- **BLOCKING:** s1 = pindah **sales**; s2 = pindah **hari** + pekan.
- Popup toko menampilkan **sales aktual + pola** (M1/M2C13/M2C24) → user tahu tujuan pindah.

**Terbukti persist (DB plan V6, TRAFFIC):** `C2257748` s1 zona→Selasa; `C2259594` s2 →
sales `…-02`, Senin, ganjil. Override (`schedule_override` → `_build_from_override`) jalan
untuk **kedua** filosofi.

**Masalah asal (arsip):** `applyMove` semula berasumsi BLOCKING — "pindah hari"
mempertahankan sales lama; di TRAFFIC (day-first) itu tak konsisten karena *hari* yang
menentukan salesman. Diperbaiki dengan `applyMove` sadar-filosofi (Opsi 1 gate-saja
**tidak** diambil).

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

## F. Filosofi objektif engine — keputusan & penundaan sadar (sesi 11)

Kritik "vs standar industri" (balance beban/potensi, rute road-aware, kapasitas waktu,
frekuensi-diturunkan) sebagian besar berasal dari literatur **optimasi salesforce matang**.
Engine ini **perencana dari-0**, bukan optimizer operasi berjalan — penyempurnaan itu
**ditunda sadar**, bukan luput. Menambahkannya tanpa data operasional nyata = presisi semu.

| Aspek | Standar (optimasi matang) | Keputusan kita | Rasional |
|------|---------------------------|----------------|----------|
| **Balance** | beban (frekuensi×waktu) / potensi (omset) | **COUNT** | "adil kasat mata = sama jumlah". Balance omset **vs** compactness = trade-off → **pilih compactness**. |
| **Balance jarak/waktu** | drive-time matrix | **ditunda → pasca-OSM** | garis-lurus menipu (membelah gunung/sungai). **Pertimbangkan ulang saat OSM live** (item E) — *permintaan eksplisit user*. |
| **Split pekan (ganjil/genap)** | ratakan beban antar-pekan (PVRP) | **K-Means geografis, tak diratakan** | geo-split beli (a) verifiable-di-peta + (b) rute per-pekan rapat. Meratakan → rute menyebar → **biaya compactness**. Kandidat peningkatan: terapkan toleransi ±X ke layer ini — hati-hati distorsi compactness + coverage. |
| **Contiguity** | dijamin (SKATER/districting) | **muncul sendiri (tak dijamin)** | level berikutnya; sering ko-resolve dgn clustering road-aware (E). |
| **Kapasitas jam-kerja/hari** | Σ waktu-layan+travel ≤ jam kerja | **tak dimodelkan** | tanpa OSM, estimasi waktu = kosmetik. Fase berdata. |
| **Frekuensi kunjungan** | diturunkan dari nilai akun (ABC) | **INPUT apa adanya** | data terbatas; observasi lapangan dulu. |

**Linchpin = item E (OSM).** Ia membuka kembali baris *balance-jarak*, *kapasitas-waktu*,
dan *contiguity road-aware* sekaligus — sebagian besar §F **menunggu E**.

**Pemisahan untuk diobservasi (bukan aksi sekarang):** *bobot frekuensi* ≠ *omset*. Toko
BIWEEKLY = ½ beban-kunjungan WEEKLY per pekan → koreksi **count**, bukan **nilai**: tak
menyeret toko jauh seperti omset (murah secara compactness), tapi butuh formulasi
*capacitated-clustering* (bukan flag) & tetap pakai sebagian budget compactness. **Ukur
dulu:** seberapa timpang campuran WEEKLY/BIWEEKLY antar-sales? Seragam → COUNT ≈ beban-per-pekan
(tak masalah); timpang → kandidat penyempurnaan **paling murah** di tabel ini.

**Pemisahan untuk split pekan:** imbalance di **partisi sales** = sinyal white-space (zona
kurang coverage → sales akuisisi baru; **jangan** diratakan paksa). Tapi imbalance
**ganjil/genap dalam satu sales** = toko **sama** dibelah ke dua pekan = *ayunan beban
antar-pekan*, bukan sinyal pasar. Pertanyaan satu-satunya: **sanggupkah sales menyerap
pekan-berat/pekan-ringan?** → operasional, bukan algoritmik.

---

## Lintas-isu — WAJIB sebelum trial luas

- **C1 — Otorisasi di API.** ⚠️ **Status 2026-07-17 (sesi 12, malam): jalur TULIS ditutup, jalur BACA
  MASIH BOCOR.** DB Supabase ini **dipakai bersama** project nabati-heroes (~82 user aktif, login harian).
  `_verify_jwt` (`api.py:111`) hanya `db.auth.get_user(token)` → memvalidasi token ke GoTrue project
  **yang sama** → **JWT user aplikasi LAIN lolos**.
  **Sudah ditutup (level DB):** guard `auth.uid()`/`COALESCE(auth.uid(),p_created_by)` LIVE di
  `get_my_profile` + 5 RPC mutasi (`approve_plan`/`discard_plan`/`save_plan`/`stage_stores`/
  `upsert_stores`) — `supabase/migrations/0003_guard_authz_rpc.sql` + `0004_fix_save_plan_service_role_guard.sql`
  (regresi `save_plan` via service_role ditemukan & diperbaiki hari yang sama). Terverifikasi HTTP
  sungguhan: user nabati-heroes (Putri) ditolak `42501`, ADMIN JKS lolos. `/generate-plan` (dry_run=false,
  **MENULIS** plan) kini aman. **Regresi tak akan lagi lolos senyap** — `tests/test_rpc_authz.py`
  (15 test, integrasi ke DB live via transaksi rollback) mengunci perilaku ini; dikonfirmasi test
  tsb GAGAL kalau versi pra-`0004` diterapkan ulang (lihat commit test).
  **MASIH TERBUKA:** `get_stores_by_area` (dipanggil service_role di `api.py:327,765,829` untuk
  `/generate-plan`,`/stage1`,`/stage2`) **tak ter-guard** — nol cek membership. Beda dari `save_plan`,
  fungsi ini hanya terima `p_area_id`, tak ada parameter identitas pemanggil utk fallback pola
  `COALESCE`. User nabati-heroes mana pun masih bisa baca seluruh toko area mana pun (`customer_code`
  + lat/lon) via ketiga endpoint itu. **Perbaikan kemungkinan di level `api.py`** (cek membership
  setelah `_verify_jwt`, sebelum panggil `get_stores_by_area`) — bukan migrasi SQL, perlu redeploy.
  BELUM dikerjakan.
- **H1 — Validasi engine secret.** `X-Engine-Secret`/`ROUTE_ENGINE_SECRET` belum divalidasi.
  ⚠️ Catatan sesi 12: **pengirimnya (Edge Function) = jalur MATI** — `RoutingEnginePage` `fetch()`
  langsung browser→FastAPI, tak pernah `functions.invoke`. Shared-secret tak cocok untuk jalur nyata
  (rahasianya harus dikirim ke browser). Pertimbangkan ulang bentuknya, jangan salin resep lama.
- → **Perbaiki sebelum membuka trial ke banyak user.** Sampai itu, trial wajib tertutup.
- **Ketergantungan DB bersama** — lihat `docs/incident-2026-07-17/README.md`: login JKS pernah mati
  total gara-gara bug di hook milik project lain. Risiko ini permanen selama DB dipakai bersama.

---

## Urutan disarankan + rasional

> Catatan: urutan ini **beda** dari urutan kamu menyebut item — silakan timpa sesuai
> prioritas bisnis. Rasional di bawah.

- **Fase 0 — Hardening (sekarang):** **C1/H1** (A ✅ selesai). Mengamankan pra-trial.
  Tak menunda apa pun.
- **Fase 1 — Iterasi plan:** **B (edit draft)**. Reuse editor yang baru jadi, nilai
  tinggi (plan jadi benar-benar bisa diolah ulang).
- **Fase 2 — Siap lapangan:** **D (kode sales real)**. Infra DB sudah ada; wajib agar
  output dipahami sales/supervisor nyata. *(Naikkan ke Fase 1 bila rollout sudah dekat.)*
- **Fase 3 — Import:** **C (upload plan)**. Tergantung mesin editor dari B.
- **Fase 4 — Realism:** **E (OSM)**. Capstone, independen, terbesar; bisa diselipkan
  kapan saja bila ada kapasitas.

---

## Keputusan terbuka (ringkasan — butuh user)

1. ~~**TRAFFIC:** gate vs semantik penuh~~ → **RESOLVED**: Opsi 2 (semantik penuh) dibangun + terbukti V6.
2. **Edit draft:** plan approved read-only? Tiap edit jadi versi baru?
3. **Mapping sales:** resolve-saat-baca vs simpan-kode-real? (audit `get_salesman_slots` dulu)
4. **OSM:** OSRM self-host (rekomendasi) vs Google? Saat-save vs on-demand? Hosting di mana?
5. **Import:** format kolom + sumber kode sales?
6. **Prioritas:** setuju urutan fase di atas, atau naikkan D (kode sales real) lebih awal?
