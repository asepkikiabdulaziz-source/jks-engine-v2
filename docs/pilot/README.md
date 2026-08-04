# Paket Tes Distributor Kedua

> Dibuat: 2026-08-04 · Status: siap dipakai
> Menjawab **satu** pertanyaan: *apakah engine ini menghasilkan plan yang berguna
> untuk data di luar Nabati, tanpa penyesuaian khusus?*

Kalau jawabannya ya — ada bukti untuk membangun platform.
Kalau tidak — berbulan-bulan pekerjaan platform baru saja dihemat.

Tes ini **tidak menyentuh database sama sekali**. Tak ada akun, tak ada tenant,
tak ada kode platform. CSV masuk, HTML + CSV keluar.

---

## 0. Kenapa offline, bukan lewat aplikasi

`upsert_stores` menolak `area_id` yang tidak ada di `mst_area.areas`
([0003:373](../../supabase/migrations/0003_guard_authz_rpc.sql)), dan `mst_area`
adalah master data milik **nabati-heroes**. Memuat data distributor lain lewat
aplikasi berarti menyisipkan area palsu ke bagan organisasi perusahaan lain.

`route_engine/` tidak punya ketergantungan DB sama sekali (nol import Supabase,
nol `area_id`), jadi ia bisa dijalankan langsung. Itulah yang dipakai di sini.

---

## 1. Kualifikasi calon — tanyakan SEBELUM demo

Satu pertanyaan menyaring lebih dari 90% ketidakcocokan:

> **"Apakah titik koordinat (GPS) toko-toko Anda sudah tersimpan?"**

Aplikasi ini **tidak melakukan geocoding**. `latitude` + `longitude` wajib ada
([UploadTokoPage.tsx:63](../../src/pages/UploadTokoPage.tsx)). Yang dilakukan
sistem adalah *reverse*-geocoding — memperkaya koordinat dengan nama kecamatan,
bukan membuat koordinat dari alamat.

Profil yang dicari:

> **Distributor yang sudah punya aplikasi sales mobile / SFA (jadi punya GPS toko),
> tapi masih merencanakan teritori di Excel.**

Pertanyaan lanjutan, sebelum meminta data:

| Pertanyaan | Kalau jawabannya "tidak" |
|---|---|
| Toko dikunjungi berdasarkan siklus tetap (mingguan / 2-mingguan)? | Siklus lain (bulanan, rotasi 3-pekan) **belum didukung** — catat, jangan janjikan |
| Salesman berangkat dari satu depo/gudang tiap pagi? | Model depo sebagai jangkar tidak berlaku — kemungkinan bukan calon yang cocok |
| Ada beberapa divisi/lini produk dengan armada sales berbeda? | Bukan masalah — tapi engine merencanakan satu divisi per run |
| Wilayahnya di Indonesia? | Validasi koordinat saat ini dikunci ke Indonesia |

---

## 2. Data yang diminta

Satu file CSV. Template siap pakai: [`template_toko.csv`](template_toko.csv).

**Wajib:**

| Kolom | Alias yang diterima | Catatan |
|---|---|---|
| `customer_code` | `kode`, `code` | unik; duplikat = ditolak |
| `customer_name` | `nama`, `name`, `toko` | |
| `latitude` | `lat` | -11..6 (Indonesia) |
| `longitude` | `lon`, `lng` | 95..141 (Indonesia) |

**Opsional tapi sangat dianjurkan:**

| Kolom | Alias | Kenapa penting |
|---|---|---|
| `visit_frequency` | `frekuensi`, `kunjungan` | `WEEKLY` / `BIWEEKLY`. **Tanpa ini semua toko dianggap BIWEEKLY** dan jadwalnya akan salah untuk toko yang mestinya dikunjungi tiap pekan |
| `div_sls` | `divisi`, `division` | wajib bila ada >1 divisi |
| `type` | `tier`, `tipe` | belum dipakai engine; disiapkan |
| `omset` | `omzet` | belum dipakai engine (lihat ROADMAP §F) |

Alias sengaja disamakan persis dengan aplikasi, supaya file yang lolos di tes ini
juga lolos di aplikasi nanti — satu kontrak, bukan dua yang perlahan menyimpang.

**Yang TIDAK perlu diminta:** alamat, nama pemilik, nomor telepon, riwayat
transaksi. Minta seminimal mungkin — ini data komersial sensitif milik calon
pelanggan, dan meminta lebih dari yang dibutuhkan memperlambat persetujuan
internal mereka.

---

## 3. Menjalankan

```bash
python scripts/pilot_run.py --csv data.csv --depo-lat -6.20 --depo-lon 106.82 --sales 5 --div SNACK
```

| Argumen | |
|---|---|
| `--csv` | file data toko |
| `--depo-lat` / `--depo-lon` | koordinat depo/gudang |
| `--sales` | jumlah salesman yang tersedia |
| `--days` | hari kerja per pekan (default 6) |
| `--cycle` | `M1` (tiap pekan) atau `M2` (ganjil/genap, default) |
| `--div` | wajib bila data multi-divisi |
| `--out` | folder keluaran (default `pilot_out/`) |

Keluaran:
- `plan.html` — visualizer mandiri, BLOCKING vs TRAFFIC berdampingan, **tanpa internet**
- `assignments_BLOCKING.csv`, `assignments_TRAFFIC.csv` — satu baris per toko, bisa dibuka di Excel

Baris cacat **menggagalkan run** dan dilaporkan per baris — tidak dilewati
diam-diam. Jalankan sekali untuk tiap divisi.

---

## 4. Cara menilai — tetapkan SEBELUM melihat hasil

Tes yang cuma mencari pembenaran tidak ada gunanya. Empat pertanyaan ke calon
pengguna, setelah mereka melihat `plan.html`:

1. **"Kalau besok pagi plan ini diberikan ke salesman, bisa dipakai?"**
   Ya / ya-dengan-sedikit-geser / tidak.
2. **"Berapa persen toko yang menurut Anda salah tempat?"**
   Angka, bukan kesan. <10% = kuat. >30% = engine tak menangkap sesuatu yang penting.
3. **"Dibanding cara Anda merencanakan sekarang, ini lebih baik atau lebih buruk?"**
   Pembandingnya harus praktik mereka sekarang, bukan kesempurnaan.
4. **"Dari dua pilihan ini — BLOCKING dan TRAFFIC — mana yang cocok dengan cara
   kerja Anda?"**
   Ini menguji **posisi produk**, bukan output. Kalau mereka tidak mengenali
   perbedaannya sebagai pilihan nyata yang mereka hadapi, pembeda utamamu tidak
   terlihat oleh pembeli.

### Sinyal yang harus dicatat, termasuk yang tidak menyenangkan

| Sinyal | Artinya |
|---|---|
| Tidak punya koordinat toko | Pasarnya lebih kecil dari harapan; geocoding jadi prasyarat produk |
| Butuh siklus selain mingguan/2-mingguan | Niche lebih sempit dari asumsi; cadence generik = pekerjaan engine |
| **"Rutenya aneh, memotong sungai / lewat jalan yang tidak bisa dilewati"** | OSRM (ROADMAP item E) adalah **blocker**, bukan penyempurnaan. `visit_order` sekarang dari haversine — dokumen sendiri menyebutnya "menipu" |
| Tak bisa membedakan BLOCKING vs TRAFFIC | Pembedamu tak terbaca pembeli; perlu diubah cara menjelaskannya |
| "Bagus, tapi kami butuh integrasi ke sistem kami dulu" | Bukan penolakan — tapi biaya akuisisi jauh lebih tinggi dari dugaan |

---

## 5. Yang sengaja TIDAK diuji

Supaya tesnya tetap murah dan jawabannya tetap jelas:

- signup, tenant, billing, izin akses
- upload lewat UI (dipakai CSV langsung)
- penyimpanan plan, versioning, alur persetujuan
- optimasi rute road-aware

Semua itu baru relevan **setelah** pertanyaan di judul dokumen ini terjawab ya.

---

## 6. Cacat yang diketahui — sampaikan apa adanya, jangan disembunyikan

**`visit_frequency` tidak berfungsi di produksi.** Terverifikasi 2026-08-04:

```
jks_engine.stores.visit_frequency          = text,    nilai '1' untuk SEMUA 22.674 toko
jks_engine.stores_staging.visit_frequency  = integer  (tipe berbeda dari tabel final)
```

`_store_visit_freq` ([api.py:104](../../api.py)) hanya mencocokkan string
`"WEEKLY"`. Nilai `'1'` tak pernah cocok → **semua toko jatuh ke BIWEEKLY**, dan
cabang WEEKLY jadi kode mati.

Akibatnya nyata, bukan teoretis: `split_ganjil_genap` sebenarnya menangani WEEKLY
dengan benar (`(True, True)` = tiap pekan), tapi karena tak pernah menerimanya,
**setiap toko dibelah ke pekan ganjil/genap** — termasuk yang mestinya dikunjungi
tiap pekan.

**Dikonfirmasi pemilik data (2026-08-04): `'1'` berarti MINGGUAN.** Jadi
pemetaannya terbalik penuh — seluruh toko mingguan, seluruhnya diperlakukan
2-mingguan.

Dampaknya terukur di data, bukan teoretis:

```
plans        : 2 APPROVED, 22 DRAFT
cycle        : M2 pada 25 dari 25 division-run
assignments  : 20.537 selang-pekan, 0 tiap-pekan
```

Artinya setiap toko dijadwalkan pada **separuh frekuensi** yang seharusnya, dan
dua plan berstatus APPROVED membawa kesalahan itu.

**Perbaikan sengaja DITUNDA** (keputusan pemilik, 2026-08-04): terminologi dan
logic frekuensi akan dirombak bersamaan saat model cadence dirancang ulang untuk
platform FMCG. Menambalnya sekarang berarti menambal dua kali.

Yang tetap harus diputuskan terpisah dari perombakan itu: apakah dua plan
APPROVED tersebut dipakai di lapangan. Itu pertanyaan operasional, bukan teknis.

Untuk pilot ini masalahnya sudah dihindari: `pilot_run.py` menerima
`visit_frequency` langsung dari CSV dan melaporkan bila kolomnya tidak ada.
Tapi kalau distributor kedua datang dengan frekuensi campuran dan pipeline
aplikasi yang dipakai, hasilnya akan salah tanpa ada yang menyadari.

**Cacat lain yang perlu diketahui:**

- `UploadTokoPage` tidak mengumpulkan `visit_frequency` sama sekali (0 rujukan) —
  jadi lewat UI, frekuensi tak pernah bisa dikirim
- Tiga halaman besar frontend tidak memeriksa `error` RPC — kegagalan tampil
  sebagai empty-state yang tampak sah. Internal ini membingungkan; di onboarding
  self-serve ini kehilangan pelanggan tanpa jejak
- `visit_order` dari haversine, bukan jaringan jalan

---

## 7. Setelah tes

Catat jawabannya di dokumen ini (tambahkan bagian "Hasil"), termasuk yang
mengecewakan. Keputusan membangun platform diambil dari catatan itu, bukan dari
ingatan tentang bagaimana rasanya demo berjalan.
