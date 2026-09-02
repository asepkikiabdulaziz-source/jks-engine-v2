# ROADMAP — JKS Route Engine v2

> **Ditulis ulang: 2026-09-02.** Versi sebelumnya (sesi 11, 2026-06-09, item A–F) ada utuh di
> riwayat git — tidak disunting, tidak dihapus.
>
> Setiap "kondisi sekarang" di dokumen ini **diverifikasi ke DB live pada 2026-09-02**
> (psycopg2 read-only), bukan disalin dari versi lama. Yang tidak bisa diverifikasi ditandai.

---

## 0. Kenapa ditulis ulang sekarang, padahal `VISI.md` menyuruh menunggu

`VISI.md` menulis: *"ROADMAP baru ditulis ulang **setelah** arah ini dikunci, bukan
sebelumnya."* Arahnya **belum dikunci** — `VISI.md` masih berstatus BELUM DIKUNCI dan belum
diuji ke pelanggan mana pun. Jadi secara harfiah, dokumen ini ditulis lebih cepat dari yang
direncanakan sendiri.

Alasannya satu, dan bukan soal arah produk: **sejak 2026-08-05 aplikasi produksi mati.**
nabati-heroes menjalankan migrasi `0525` yang menghapus 17 RPC JKS dari schema `public` atas
keputusan pemilik repo — JKS pisah ke project Supabase sendiri. Roadmap lama menjadwalkan
pekerjaan **di atas fondasi yang sudah tidak ada**: item B mengandaikan "RPC `approve_plan`,
`discard_plan`, `next_plan_version`, `get_plan_assignments` semua ADA", §Lintas-isu masih
menulis "wajib sebelum trial dibuka luas". Tidak ada trial; tidak ada aplikasi.

Konsekuensinya untuk bentuk dokumen ini: **ia dipecah menurut apa yang tergantung arah dan
apa yang tidak.** Fase 0 dan 1 di bawah wajib dikerjakan **di setiap cabang** — tool internal
maupun platform publik sama-sama butuh DB, auth, dan data. Yang benar-benar bergantung pada
arah diparkir di §Fase 2 sebagai **dua cabang berdampingan**, tidak dipilih di sini. Itu
keputusan user, dan `VISI.md` benar bahwa ia belum bisa diambil.

---

## 1. Titik awal — keadaan terverifikasi 2026-09-02

| | |
|---|---|
| RPC JKS di `public` | **3 dari 20** tersisa: `get_routing_regions` / `_cabangs` / `_areas` |
| Data `jks_engine` | **UTUH** — `stores` 22.674 · `plans` 24 (**3 APPROVED**, 21 DRAFT) · `plan_assignments` 20.537 · `gadm_regions` 77.473 · `access_roles` 2 |
| Sebaran data | 25 `area_id`; `div_sls`: TX2DA 20.192 · SMD 2.432 · AEGDA 49 · AEPDA 1 |
| Ledger migrasi | berhenti di **`0006`**. `0007`–`0010` belum menyentuh DB mana pun kecuali sandbox Docker |
| Rantai `0001`–`0010` | **terbukti replay bersih dari nol** + lulus uji fungsional end-to-end di Postgres+PostGIS Docker (commit `62b6ce6`) |
| Test lokal | engine **41** · Path A **14** · visit_frequency **19** — semua hijau |
| Test integrasi DB | `test_rpc_authz.py` **33 gagal / 3 lulus** — merah karena RPC-nya hilang, bukan regresi |
| Master data wilayah | `mst_area` = **1.028 baris** milik Heroes (regions 20 · cabangs 86 · areas 374 · ldcs 283 · area_coverage 265) |
| Engine | **nol** import Supabase, nol rujukan `area_id`/`kd_dist` — satu-satunya bagian yang pindah tanpa cedera |

---

## 2. Fase 0 — DB baru & identitas sendiri · **BLOCKER TUNGGAL**

Tidak ada satu pun item lain yang bisa dikerjakan lebih dulu, karena tanpa DB tidak ada
aplikasi. Semua sub-item di bawah wajib **di setiap cabang arah produk**.

### 0.1 Provisioning project Supabase baru
Rantai `0001`–`0010` sudah jadi dan sudah diuji replay dari nol. Yang belum ada: project-nya.

⚠️ **Ranjau yang sudah ditemukan dan sudah ditutup** — jangan diulang, tapi ketahui bahwa ia
ada: replay ke DB kosong menunjukkan **18 dari 20 RPC lahir terbuka ke `anon`**. Selama ini
yang melindunginya adalah sapuan keamanan **milik Heroes** (migrasi `0297` mereka), bukan
migrasi JKS sendiri. Ditutup `0010`. Empat bug replay lainnya (sequence hilang, urutan FK,
`UPDATE … FROM LATERAL`, shim kurang kolom) juga sudah diperbaiki di rantainya.

⚠️ **Gotcha runner:** `run_migrations.py` menolak jalan kalau `jks_engine._migrations` belum
ada — padahal ledger itu dibuat oleh `0002`. Bootstrap `0002` manual dulu (lihat CLAUDE.md
§Dev Commands).

**Effort:** S–M. **Tergantung:** tak ada. **Keputusan terbuka:** region project (latensi ke
pengguna vs ke Cloud Run `asia-southeast2`), dan tier.

### 0.2 Identitas sendiri — **ditulis ulang, bukan dipindah**
`get_my_profile` bersandar pada `mst_hr.slot_assignment_flat` milik Heroes. Dua hal
menjatuhkan jalur itu sekaligus:

1. View-nya **dicabut aksesnya** — `mst_hr.v_identity_external_v1` (kontrak stabil yang
   disiapkan `0404` khusus untuk JKS) dihapus 2026-08-05 atas persetujuan kita sendiri.
2. Heroes **merombak besar** `mst_hr` sepanjang Agustus (`slot_flat` → `slot_row`, tahap
   T5–T16). Bentuk 27 kolomnya dipertahankan, tapi asal-usul `branch_code`/`region_code`
   berubah dan 477 baris arsip berubah nilai.

Jadi ini bukan "ganti nama relasi". `scripts/local-dev/shim_external_deps.sql` — yang dibuat
sebagai alat tes — sekarang berfungsi ganda sebagai **peta dari apa yang harus digantikan
sungguhan**: `auth`, `mst_hr`, `mst_area`.

**Effort:** M–L. **Tergantung:** 0.1. **Keputusan terbuka:** Supabase Auth polos (email+
password) cukup, atau langsung siapkan bentuk multi-tenant (§Fase 2B)? Menjawab ini lebih awal
lebih murah daripada memigrasi tabel user dua kali.

### 0.3 Master data wilayah — 1.028 baris yang bukan milik kita
`get_routing_regions/_cabangs/_areas` membaca `mst_area` (Heroes). Setelah pisah, JKS tak lagi
punya akses. Hierarki Region → Cabang → Area ada di `AreaContext` dan dipakai di seluruh FE.

`VISI.md` §2 sudah memutuskan arah untuk ini: **hierarki wilayah digeneralisasi sejak awal**
(tabel node parent-child, ongkos ~20%, dinilai murah) karena mempertahankan bentuk
Region/Cabang/Area yang spesifik Nabati akan menghalangi tenant lain. Fase 0 karenanya bukan
"copy 1.028 baris apa adanya" melainkan **impor Nabati sebagai satu pohon** ke dalam bentuk
generik itu.

⚠️ Kalau `VISI.md` gugur dan JKS tetap tool internal, item ini menyusut jadi impor tabel biasa.
Ini satu-satunya sub-item Fase 0 yang bentuknya berubah menurut arah — tapi **pekerjaannya
tetap wajib** di kedua cabang.

**Effort:** M. **Tergantung:** 0.1.

### 0.4 Migrasi data — belum pernah masuk daftar mana pun
22.674 toko + 24 plan + 20.537 assignment masih utuh di DB lama.

⚠️ `0525` **sengaja tidak menyentuh** schema `jks_engine` ("data milik proyek lain"), tapi
berkasnya menyebut `DROP SCHEMA jks_engine CASCADE` sebagai *"keputusan terpisah, belum
diambil"*. **Jangan diandalkan tetap begitu.** Ekspor lebih dulu; itu murah dan sekali jalan.

Yang perlu diputuskan saat impor, bukan sesudahnya: **apakah 24 plan lama ikut dibawa?**
21 di antaranya DRAFT dan 3 APPROVED, semuanya M2 dan semuanya terdampak
`visit_frequency` (§3.2). Membawa plan yang jadwalnya salah ke DB baru = mewarisi utang;
membuangnya = kehilangan jejak audit. Bukan keputusan teknis.

**Effort:** S (ekspor) + S (impor). **Tergantung:** 0.1. **Prioritas:** ekspor **sekarang**,
tak perlu menunggu apa pun.

### 0.5 Batas wilayah — COD-AB, sudah siap
`0007`/`0008` + `scripts/import_codab.py` sudah ditulis dan sudah diuji lokal. Bukan
peningkatan kosmetik: **lisensi GADM melarang penggunaan komersial** → blocker legal untuk
platform publik. COD-AB (BPS, dikurasi OCHA, CC BY 3.0 IGO) boleh komersial, kewajibannya
hanya atribusi, dan lebih lengkap (7.069 kecamatan vs 6.695; 81.912 desa vs 77.473).

Bonus yang penting untuk lapis Potensi: `adm4_pcode` = kode BPS → bisa di-JOIN ke statistik
BPS lain **lewat kode**, bukan pencocokan nama yang rapuh.

⚠️ Yang dikorbankan: vintage 2020 → ADM1 = 34 provinsi, **sebelum pemekaran Papua 2022**.

**Effort:** S (sudah jadi, tinggal apply + `import_codab.py`). **Tergantung:** 0.1.

### Syarat keluar Fase 0
Bukan "migrasi ter-apply", melainkan: **login → pilih area → lihat toko di peta → `/stage1`
sungguhan → simpan plan → baca balik**, di project baru, dengan data nyata. Ini persis alur
yang dipakai memverifikasi C1 di sesi 12 dan yang menangkap 5 bug di sesi 14 — jangan diganti
dengan pemeriksaan yang lebih murah.

---

## 3. Fase 1 — utang yang tidak boleh ikut pindah

Dikerjakan **selagi** Fase 0, bukan sesudahnya, karena dua di antaranya menentukan bentuk
skema dan lebih mahal diperbaiki setelah data masuk.

### 3.1 Fail-loud FE — **naik dari "menyebalkan" ke "mematikan"**
`AreaContext.tsx:52` · `RoutingEnginePage.tsx:1606` · `DashboardPage.tsx:239` ·
`PlanMapPage.tsx:500` tidak memeriksa `error` → RPC gagal tampil sebagai **empty-state yang
tampak sah**: "0 toko", "Upload data toko terlebih dahulu" untuk 1.500+ toko yang ada.

Doktrin "crash terlihat > menyimpang senyap" sudah ditegakkan mati-matian di engine — dan
**berhenti di batas Python**. `VISI.md` §9 menaikkan statusnya: di onboarding self-serve,
empty-state palsu = pelanggan hilang tanpa jejak.

Tambahan yang baru relevan sekarang: selama Fase 0 seluruh RPC **memang** akan gagal berkali-
kali. Tanpa fail-loud, debugging Fase 0 sendiri jadi menebak-nebak.

**Effort:** S. **Tergantung:** tak ada — bisa dikerjakan **hari ini**, sebelum DB baru ada.

### 3.2 `visit_frequency` — jumlah plan terdampak BERTAMBAH
Kolom `text` berisi `'1'` untuk semua 22.674 toko; `_store_visit_freq` hanya cocok dengan
`"WEEKLY"` → semua jatuh ke BIWEEKLY → **20.537 assignment dijadwalkan separuh frekuensi.**

⚠️ **Koreksi terhadap catatan lama:** yang tercatat "2 plan APPROVED". Verifikasi live
2026-09-02: **3 plan APPROVED**, semuanya `M2`, dan pada ketiganya **100% assignment terbelah
ganjil/genap** (nol baris "tiap pekan") — total 2.655 assignment:

| Plan | Approved | Assignment |
|---|---|---|
| `1000596_20260606_V1` | 2026-06-06 | 596 |
| `1000589_20260606_V4` | 2026-06-06 | 1.552 |
| `1000595_20260805_V1` | **2026-08-05** | 507 |

Yang ketiga disetujui **pada hari pencabutan**, yaitu **setelah** bug ini ditemukan (sesi 13,
08-04/05). Artinya penundaan sadar itu punya biaya yang terus bertambah selama alatnya masih
bisa dipakai — sekarang tidak lagi, tapi angkanya sudah naik.

Fix kode + SQL sudah ada (`0009` + `api.py`, 19 test) dan **belum diterapkan ke DB mana pun**.
Penundaannya tetap berpijak kuat: diverifikasi hanya memengaruhi flag ganjil/genap; penempatan
sales & hari tidak berubah. ⚠️ Tapi **naik jadi prasyarat** begitu headcount diturunkan dari
beban (`VISI.md` §5, §9) — toko mingguan = 2× beban dua-mingguan; salah baca → rekomendasi
sales **separuh** dari yang dibutuhkan, dan itu angka yang dipakai orang merekrut.

**Effort:** S (sudah jadi). **Tergantung:** 0.1. **Keputusan operasional, bukan kode:** 3 plan
APPROVED itu mau diapakan.

### 3.3 Otorisasi — C1 versi asli **belum tertutup**
Ini koreksi terhadap centang di roadmap lama. Yang selesai di sesi 12 adalah guard **biner**:
"apakah pemanggil anggota `jks_engine.access_roles`". Yang **tidak** dicek: **scope area.**
Anggota mana pun masih bisa membaca/menulis area mana pun bila tahu UUID-nya — persis
deskripsi C1 di `AUDIT.md`. Ditambah **6 RPC baca tanpa guard sama sekali**
(`get_plans_by_area`, `get_plan_assignments`, `get_routing_*`, `next_plan_version`).

Di DB bersama itu berarti ~1.300 akun Heroes. Di platform multi-tenant itu berarti
**kebocoran lintas-pelanggan** — `VISI.md` §9 menaikkannya jadi "struktural dan teruji", dan
menyebut satu kesalahan membocorkan daftar toko Perusahaan A ke B sebagai **fatal komersial**.

**Kenapa di Fase 1, bukan nanti:** kalau isolasi tenant dibangun setelah skema jadi, ia jadi
tambalan; kalau dibangun bersamaan, ia jadi bentuk tabelnya. Ongkosnya beda besar.

⚠️ Sebelum menambah guard `auth.uid()` ke RPC mana pun, **cek dulu siapa pemanggilnya** —
`service_role` melihat `auth.uid()` = NULL. Pelajaran `0003`→`0004`, ada di CLAUDE.md §0.

**Effort:** M. **Tergantung:** 0.2 (bentuk identitas menentukan bentuk scope).

### 3.4 Tiga RPC JKS yang tertinggal di schema Heroes
`get_routing_regions/_cabangs/_areas` **milik JKS** (ada di `0001_baseline.sql`) tapi hidup di
`public` milik Heroes dan membaca `mst_area` mereka. `0525` **tidak menyebutnya sama sekali** —
sapuan mereka berbasis nama, dan ketiganya kemungkinan tampak seperti fungsi mereka sendiri.

Hari ini ketiganya masih `authenticated=true` → bisa dipanggil ~1.300 akun Heroes, mengembalikan
struktur wilayah mereka sendiri (bukan data JKS, jadi bukan kebocoran JKS — tapi tetap fungsi
kita yang menganggur di schema orang lain).

**Aksi:** beri tahu Heroes agar mereka drop, atau siapkan SQL-nya untuk mereka apply. Menulis
ke schema mereka **butuh apply pemilik** — itu kesepakatan 2026-07-17, bukan pilihan.
⚠️ Jangan lupa aturan ACL: setiap `DROP FUNCTION` di `public` bisa **menghidupkan `anon`**.

**Effort:** S. **Tergantung:** tak ada.

### 3.5 H1 — `ROUTE_ENGINE_SECRET`: **bentuknya perlu diganti, bukan diselesaikan**
`X-Engine-Secret` dikirim tapi tak pernah divalidasi. ⚠️ Tapi pengirimnya — Edge Function
`generate-plan` — adalah **jalur mati**: browser memanggil FastAPI **langsung**, tak pernah
`functions.invoke`. Jadi shared-secret **tak cocok** untuk jalur nyata: rahasianya harus
dikirim ke browser, dan begitu di browser ia bukan rahasia.

**Jangan salin resep lama.** Yang sesungguhnya dibutuhkan: FastAPI memverifikasi JWT Supabase
(sudah dilakukan `_verify_jwt`) + rate limit + CORS yang benar (AUDIT H2). Rumuskan ulang
sebagai "lindungi endpoint komputasi-berat", bukan "pasang shared secret".

**Effort:** S. **Tergantung:** 0.2.

### 3.6 Sisa `AUDIT.md`
H2 (CORS prod-safe — regex `localhost` hardcoded ikut ke produksi) · M2 (batas input:
`max_items`, bound lat/lon) · M3 (pin `requirements-api.txt` ke `==`) · M4 (`python-dotenv`
eksplisit — pola fallback senyap yang dilarang doktrin sendiri) · M6 (model lock TRAFFIC vs
BLOCKING) · M8 (race double-click "Generate Jadwal"). Hilang dari roadmap lama; masih terbuka.
**Effort:** S masing-masing.

---

## 4. Fase 2 — di sini arah baru menentukan · **dua cabang, tidak dipilih di sini**

Fase 0 dan 1 identik di kedua cabang. Dari titik ini mereka berpisah, dan `VISI.md` belum
dikunci — jadi keduanya ditulis berdampingan, lengkap dengan apa yang gugur di masing-masing.

### Cabang A — tetap tool internal Nabati

Item lama yang masih hidup, dengan premisnya diperiksa ulang:

| Item | Tujuan | Status premis 2026-09-02 |
|---|---|---|
| **B — Edit plan dari draft** | buka plan DRAFT tersimpan → editor → simpan versi baru | **Premis SELAMAT** — `plans.status`, `approved_at/by`, dan RPC `approve_plan`/`discard_plan`/`next_plan_version`/`get_plan_assignments` semuanya ada di rantai `0001`–`0010`, jadi hidup lagi di DB baru. Editor + undo/redo + `schedule_override` sudah ada → ~90% infrastruktur siap. Ada 21 plan DRAFT nyata untuk diuji |
| **C — Edit plan dari upload** | import plan jadi (Excel/sistem lama) → editor → simpan | Tergantung B. Pola ingest + panel anomali sudah dikenal dari Upload Toko |
| **D — Mapping ke kode sales real** | slot `SLS-02` → salesman nyata | ⚠️ **PREMIS GUGUR — lihat di bawah** |

⛔ **Item D: premisnya terbalik, dan ini temuan baru 2026-09-02.**
Roadmap lama menyimpulkan *"infrastruktur salesman sudah ada … ini **bukan** bangun dari nol,
lebih ke **menyambungkan** yang sudah ada"*, berdasarkan keberadaan `get_salesman_slots`,
`get_salesman_slot_info`, `get_salesman_supervisor_map`, `resolve_salesman_email_v2`.

Diverifikasi lewat `pg_proc` (owner + schema): **keenam belas fungsi `%salesman%` di prod
semuanya ada di `public` milik Heroes, owner `postgres`.** Tidak satu pun milik JKS, tidak
satu pun ada di `0001_baseline.sql`. Selama JKS menumpang, "sudah ada" itu benar — tapi ia
"ada" milik orang lain. **Setelah pisah, JKS tidak punya satu pun dari itu.**

Jadi D berbalik dari **M (menyambungkan)** menjadi **L (bangun atau impor dari nol)**: perlu
model salesman sendiri, atau impor dari Nabati sebagai data, atau integrasi eksplisit ke HR
mereka. Ini contoh langsung dari prinsip CLAUDE.md §0 — "sudah ada" di DB bersama bukan
kepemilikan.

### Cabang B — platform publik niche FMCG (`VISI.md`)

Yang menggantikan item B/C/D sebagai prioritas:

| Pekerjaan | Kenapa lebih dulu dari yang lain | Rujukan |
|---|---|---|
| **Isolasi antar-tenant, struktural & teruji** | satu kebocoran daftar toko A ke B = fatal komersial. Menyatu dengan §3.3 — kerjakan sebagai satu hal, bukan dua | VISI §9 |
| **Lapis SIMULASI** (`n_sales` jadi keluaran) | pertanyaan bisnis yang sesungguhnya. **Nol kode engine baru** — hitung `N × layan + rute ÷ kecepatan` per blok, tunjukkan blok yang lewat 8 jam, user geser `n`. Keluarannya **kurva**, bukan satu angka | VISI §5 |
| **Onboarding self-serve** | konsekuensi langsung pendaftaran terbuka; menjadikan §3.1 (fail-loud FE) prasyarat, bukan kerapian | VISI §1, §9 |
| **Deteksi whitespace** (lapis Potensi v0) | **nol karangan** — murni geometris dari `admin_regions` + titik toko. "Kecamatan X: 0 toko; enam kecamatan berbatasan rata-rata 45 toko" | VISI §6.2 |
| **"Tuyul v0" — pelanggan yang kabur** | sasaran 100% milik data mereka sendiri; tanpa ToS, tanpa crawling, tanpa masalah pencocokan. Nilainya **diketahui**, bukan ditaksir | VISI §6.6 |

**Yang gugur di cabang ini:** gagasan "shortcut dari aplikasi Heroes" (kontradiktif dengan
pendaftaran terbuka), dan `_build_from_territories` + 15 RPC `SECURITY DEFINER` + kopling
`mst_area` + monolit 2.420 baris ikut dibuang bersama cangkangnya (~85% ditulis ulang).

**Yang ikut sebagai DNA:** `route_engine/` **dipindah sebagai satu paket terpasang, jangan
disalin** — dua salinan akan menyimpang dalam hitungan bulan; 41 test acceptance-nya sebagai
tali pengaman seluruh migrasi; doktrin fail-loud; dua filosofi BLOCKING/TRAFFIC; "engine
merekomendasi, manusia memutuskan".

### Yang sama di kedua cabang

| Item | Catatan |
|---|---|
| **E — Optimasi rute road-aware (OSRM)** | `visit_order` sekarang dari `nn_tour` haversine → urutan "menipu". **Sifatnya berubah** menurut `VISI.md` §9: bukan lagi soal rute yang enak dilihat, melainkan **kredibilitas angka yang dipakai merekrut**. Arsitektur tetap: enrichment **di luar** engine, per blok (sales, hari) ~50 toko = 1 panggilan `/trip`. **Rekomendasi tetap OSRM self-host** (gratis) di atas Google (ToS caching + mahal untuk 1.552 toko × banyak blok). ⚠️ `VISI.md` §8.1: jejak GPS salesman sendiri **lebih baik dari OSRM** untuk kalibrasi — kalau SFA ada, sebagian E tergantikan. Syaratnya jejak **pasif**; check-in manual akan diborong sore hari |
| **Balance jarak/waktu** | terbuka kembali begitu beban terukur dalam **jam**, persis seperti §5 memperkirakan. Tergantung E |
| **Biaya perpindahan wilayah** | plan **kedua dan seterusnya** harus meminimalkan perpindahan toko antar salesman: hubungan putus, piutang rancu. *"Tambah 1 sales dengan memindahkan 180 toko"* vs *"340 toko"* sangat berbeda bagi yang menjalankannya | VISI §8.2 |
| **Rumah salesman sebagai jangkar** | engine cuma tahu depo. Sales yang tinggal di utara tapi dapat wilayah selatan kehilangan sejam sebelum mulai kerja. Murah, langsung terasa | VISI §8.4 |

---

## 5. Filosofi objektif engine — **dipertahankan utuh, masih berlaku**

Bagian ini dari roadmap lama (§F, sesi 11) **tidak diubah isinya** — ia catatan keputusan, dan
keputusannya masih berdiri. Yang ditambahkan hanya kolom status terhadap `VISI.md`.

Kritik "vs standar industri" (balance beban/potensi, rute road-aware, kapasitas waktu,
frekuensi-diturunkan) sebagian besar berasal dari literatur **optimasi salesforce matang**.
Engine ini **perencana dari-0**, bukan optimizer operasi berjalan — penyempurnaan itu
**ditunda sadar**, bukan luput. Menambahkannya tanpa data operasional nyata = presisi semu.

| Aspek | Standar (optimasi matang) | Keputusan kita | Rasional | Status vs VISI |
|---|---|---|---|---|
| **Balance** | beban (frekuensi×waktu) / potensi (omset) | **COUNT** | "adil kasat mata = sama jumlah". Balance omset **vs** compactness = trade-off → **pilih compactness** | ⬆️ **alasannya menguat** — lihat di bawah |
| **Balance jarak/waktu** | drive-time matrix | **ditunda → pasca-OSM** | garis-lurus menipu (membelah gunung/sungai) | terbuka kembali saat beban terukur dalam jam |
| **Split pekan (ganjil/genap)** | ratakan beban antar-pekan (PVRP) | **K-Means geografis, tak diratakan** | geo-split beli (a) verifiable-di-peta + (b) rute per-pekan rapat. Meratakan → rute menyebar → **biaya compactness** | tak berubah |
| **Contiguity** | dijamin (SKATER/districting) | **muncul sendiri (tak dijamin)** | level berikutnya; sering ko-resolve dgn clustering road-aware | ✅ kini **diukur & dilaporkan** (`core/contiguity.py`, 2026-08-05) — tetap tidak dipaksa |
| **Kapasitas jam-kerja/hari** | Σ waktu-layan+travel ≤ jam kerja | **tak dimodelkan** | tanpa OSM, estimasi waktu = kosmetik | ⬆️ **jadi inti lapis Simulasi** (VISI §5.2) — boleh dibangun tanpa OSRM **asal setiap faktor konversi diisi user dan terlihat di layar** |
| **Frekuensi kunjungan** | diturunkan dari nilai akun (ABC) | **INPUT apa adanya** | data terbatas; observasi lapangan dulu | ⬆️ jadi **tuas what-if** tingkat layanan (VISI §5.5) |

⬆️ **Kenapa alasan compactness menguat.** §F memilih compactness di atas balance dengan alasan
**keterbacaan peta**. `VISI.md` §7 membawa kebenaran lapangan yang jauh lebih kuat, dan datang
dari user, bukan dari literatur: **salesman secara natural malas** — bukan penilaian moral,
melainkan fakta rancangan insentif (mereka dibayar atas penjualan, bukan kepatuhan).

> **Rencana terbaik bukan yang paling optimal, tapi yang paling mungkin dijalankan.**

Rute rapat = lebih sedikit berkendara di bawah matahari → **compactness adalah fitur adopsi,
bukan estetika.** Ia satu-satunya fitur di produk ini yang menguntungkan salesman **secara
langsung, hari itu juga**. Plan yang 5% lebih efisien tapi membuat harinya terasa lebih berat
akan diabaikan, dan efisiensinya nol. **Pertahankan mati-matian.**

**Pemisahan untuk diobservasi (bukan aksi):** *bobot frekuensi* ≠ *omset*. Toko BIWEEKLY = ½
beban-kunjungan WEEKLY per pekan → koreksi **count**, bukan **nilai**: tak menyeret toko jauh
seperti omset (murah secara compactness), tapi butuh formulasi *capacitated-clustering* (bukan
flag). **Ukur dulu:** seberapa timpang campuran WEEKLY/BIWEEKLY antar-sales? Seragam → COUNT ≈
beban-per-pekan; timpang → kandidat penyempurnaan **paling murah** di tabel ini.
⚠️ Pengukuran itu **tak bisa dilakukan sekarang**: `visit_frequency` di prod seragam `'1'`
(§3.2), jadi campurannya artifisial. §3.2 adalah prasyarat pengukuran ini, bukan cuma prasyarat
Simulasi.

**Pemisahan untuk split pekan:** imbalance di **partisi sales** = sinyal white-space (jangan
diratakan paksa — dan `VISI.md` §9 menaikkannya dari catatan pinggir jadi **fitur utama**).
Tapi imbalance **ganjil/genap dalam satu sales** = toko **sama** dibelah ke dua pekan = ayunan
beban antar-pekan, bukan sinyal pasar. Pertanyaan satu-satunya: **sanggupkah sales menyerap
pekan-berat/pekan-ringan?** → operasional, bukan algoritmik.

---

## 6. Prinsip yang dijaga

- **Engine core tetap deterministik & no-network.** Apa pun yang butuh jaringan atau
  pembelajaran (OSM/Google/ML) = **layer enrichment terpisah**, hasilnya masuk sebagai data
  berversi. ML **tidak boleh** masuk `route_engine/` — ia melanggar "input sama → output
  identik" **diam-diam**, dan tak satu test pun akan menangkapnya (`docs/ML.md` §2).
- **Engine merekomendasi, manusia memutuskan.** Bentuk paling murni dari ini adalah lapis
  Simulasi sebagai **what-if**, bukan rekomendasi: *"kalau 10 sales, beginilah jadinya"*
  memindahkan kepemilikan klaim ke mereka yang memutuskan (VISI §5.4).
- **Verifikasi dulu, anti-kosmetik, root-cause sebelum solusi.**
- **Fail-loud, tanpa fallback senyap** — dan doktrin itu **berlaku sampai FE**, bukan berhenti
  di batas Python (§3.1).
- **Replay ke DB lokal sebelum menyentuh DB sungguhan.** Sekali dijalankan, ia menemukan 5 bug
  yang tak pernah ketahuan bertahun — termasuk satu lubang keamanan. Ini bukan formalitas.
- **"Sudah ada di DB" ≠ milik kita.** Item D (§4 Cabang A) adalah harga dari melewatkan ini.

---

## 7. Keputusan terbuka — butuh user

Diurutkan menurut **seberapa banyak pekerjaan yang terhalang**, bukan menurut kemudahan.

1. **Arah produk: dikunci atau belum?** `VISI.md` masih BELUM DIKUNCI. Fase 0–1 jalan tanpa
   jawaban ini; Fase 2 tidak bisa dimulai tanpanya.
2. **Auth: Supabase Auth polos, atau langsung bentuk multi-tenant?** (§0.2) Menjawab lebih
   awal jauh lebih murah daripada memigrasi tabel user dua kali.
3. **Hierarki wilayah: impor Nabati apa adanya, atau langsung bentuk node generik?** (§0.3)
   `VISI.md` §2 sudah memilih generik dan menyebut ongkosnya murah (~20%) — perlu konfirmasi.
4. **24 plan lama ikut dibawa ke DB baru?** (§0.4) 21 DRAFT + 3 APPROVED, ketiganya berjadwal
   separuh frekuensi. Bawa = mewarisi utang; buang = kehilangan jejak audit.
5. **3 plan APPROVED itu diapakan?** (§3.2) Keputusan operasional, tidak menunggu kode.
6. **Cangkang: ditulis ulang sekalian saat pindah, atau di-porting dulu supaya ada yang
   jalan?** `VISI.md` §2 mengukurnya: ~15% (`route_engine/`) selamat utuh, ~85% ditulis ulang.
   Porting dulu = lebih cepat ada aplikasi, tapi dua kali kerja bila cabang B dipilih.
7. **OSRM: self-host (rekomendasi) vs Google? saat-save vs on-demand? hosting di mana?**
   Belum berubah dari roadmap lama, dan masih paling independen.
8. **Dua pertanyaan ke distributor mana pun — murah, dan mengubah banyak isi `VISI.md`:**
   *"koordinat toko sudah tersimpan?"* dan *"siapa yang membuka toko baru — sales yang sama,
   atau orang lain?"* Yang kedua menentukan apakah simulasi headcount punya **dua jenis
   sales** dengan kapasitas berbeda (VISI §7, §10).

---

## 8. Yang sudah selesai — jangan dikerjakan ulang

- **A — adjustment TRAFFIC sadar-filosofi** (Opsi 2, semantik penuh — bukan gate). TRAFFIC:
  s1 = pindah zona-hari, s2 = pindah sales + pekan; BLOCKING: s1 = pindah sales, s2 = pindah
  hari + pekan. **Terbukti persist via DB plan V6** untuk kedua filosofi.
- Editor hari/pekan `s2_preview` + **undo/redo terpadu**; popup toko menampilkan sales aktual
  + pola (M1/M2C13/M2C24).
- Penjadwalan hari **murni K-Means** (`slice_by_bearing` dihapus).
- Deploy Cloud Run 1-container deploy-dari-git (⚠️ menunjuk DB yang kini mati).
- Hasil plan di peta (`PlanMapPage`) + tab Wilayah; dashboard dari data nyata.
- Baseline migrasi + runner + ledger; **rantai `0001`–`0010` terbukti replay bersih**.
- C1 **jalur biner** tulis & baca (`0003`–`0005`, 7 RPC, test-first) + kebocoran `anon`
  (`0006`). ⚠️ **Bukan** C1 versi scope-area — lihat §3.3.
- AUDIT **M5** — `ROUTE_LENGTH` ditolak eksplisit di dua gerbang.
- **Path A** menjalankan QC + summary (dulu `None` dan `{}`).
- **Contiguity** teritori diukur & dilaporkan, tidak dipaksa.
- COD-AB gantikan GADM (`0007`/`0008`) + fix `visit_frequency` (`0009`) — **ditulis & diuji
  lokal, belum diterapkan** ke DB mana pun.
- **Paket tes distributor kedua** (`docs/pilot/`, `scripts/pilot_run.py`) — siap dan
  tervalidasi (`version_id` identik lewat round-trip CSV), **sengaja ditunda**: ia menguji
  komponen lama, bukan proposisi baru di `VISI.md`.
