# Di mana ML masuk — dan di mana tidak

> Ditulis: 2026-08-05 · **Bahan pengembangan, bukan rencana kerja.**
> Berpasangan dengan [`VISI.md`](VISI.md). Tak ada satu pun di sini yang dijadwalkan.
>
> Ditulis setelah menelusuri klaim "AI-integrated" pemain lain (Zylem, FieldAssist,
> Bizom) dan mendapati bahwa **kendalanya bukan model — kendalanya data.**

---

## 1. Apa arti "AI" di pasar ini (bukti, bukan dugaan)

**Hampir selalu: optimasi klasik yang diberi label baru.** K-Means, TSP/VRP solver,
integer programming, metaheuristik. Semuanya matang 1950–1990-an. Secara akademis
memang cabang AI (*search and optimization*), tapi bukan yang orang bayangkan hari
ini saat mendengar kata itu.

**Konsekuensi yang enak:** dengan standar itu, engine JKS **sudah** "AI-based"
sejak hari pertama — `KMeansConstrained` untuk partisi wilayah, nearest-neighbour
tour untuk urutan kunjungan, K-Means 2-klaster untuk pola ganjil/genap. Tak perlu
menambah apa pun untuk memakai istilah itu secara jujur.

**Yang ditemukan saat memeriksa vendor (2026-08-05):**

| Vendor | Klaim AI di halaman PRODUK | Kenyataan |
|---|---|---|
| [Zylem](https://zylem.co.in/) (Smile Automation, India) | **Nol.** Analitiknya disebut apa adanya: *"analytical module"*, *"Power BI integration"* | PJP/WJP/MJP **dicatat**, bukan dihitung. Tak ada optimasi rute |
| Zylemini+ (SFA Zylem) | 1 klaim kabur: *"smart sales forecasts"* | "smart" di tempat lain cuma berarti mudah dipakai |
| FieldAssist | *"AI-designed routes aligned to Indonesia's geographies"* | Halaman MicroMarket-nya: nol sumber data, nol ambang, nol rentang ketidakpastian |

**Pola yang layak diingat:** kalimat *"utilizes artificial intelligence... machine
learning and natural language processing"* milik Zylem muncul di **artikel blog
SEO**, bukan di halaman produk. Di pasar ini, "AI" hidup di konten pemasaran, bukan
di dokumentasi. Itu sekaligus alasan kenapa "tunjukkan rumusnya" adalah pembeda
yang terverifikasi kosong di pesaing (VISI §3.6).

---

## 2. Aturan arsitektur — ML SELALU di lapis enrichment

> **ML tidak boleh masuk ke dalam `route_engine/`. Titik.**

Alasannya bukan kerapian, melainkan kontrak: engine menjanjikan **input sama →
output identik byte-per-byte** (`_version_id` = hash SHA-1 dari isi input + config,
`random_state=42`). Model yang dilatih ulang melanggar itu **diam-diam** — plan yang
sama bisa berubah bulan depan tanpa ada yang mengubah datanya, dan tak ada satu pun
test yang menangkapnya.

Dan determinisme itulah yang membuat lapis Simulasi bermakna: membandingkan skenario
hanya sah kalau perbedaannya berasal dari asumsi, bukan dari keacakan model.

**Polanya sama persis dengan OSM/OSRM di ROADMAP §E:** apa pun yang butuh jaringan
atau pembelajaran berjalan **di luar engine**, hasilnya masuk sebagai **data berversi**
yang diperlakukan seperti masukan biasa.

```
[data mentah] → [lapis enrichment: ML, OSRM, geocoding] → [data berversi] → [engine deterministik] → [plan]
```

Kalau sebuah model mengisi `waktu_layan` per toko, yang masuk ke engine adalah
**angka hasil prediksi beserta versi modelnya**, bukan pemanggilan model. Dengan
begitu plan tetap bisa direproduksi persis, dan perubahan hasil selalu bisa
ditelusuri ke versi model tertentu.

---

## 3. Peta ML sesungguhnya adalah peta AKUISISI DATA

Ini temuan terpenting dokumen ini. Diurut bukan berdasarkan nilai, tapi berdasarkan
**data apa yang harus ada lebih dulu** — karena di situlah semuanya tersangkut.

### Tingkat 0 — dengan data yang ADA sekarang

Data yang dipegang hari ini per toko: `customer_code`, `customer_name`, `lat/lon`,
`div_sls`, `type`, `omset` (satu angka, **bukan deret waktu**), `visit_frequency`.

**Yang bisa dikerjakan: nyaris tidak ada.** Dan itu jawaban jujurnya.

Deteksi outlier koordinat sudah ada dan **berbasis aturan** (`core/qc.py`) — tidak
perlu ML, dan mengubahnya jadi ML akan menukar sesuatu yang bisa dijelaskan dengan
sesuatu yang tidak. Clustering sudah dikerjakan K-Means. Tak ada label untuk dilatih.

> **Kesimpulan tingkat 0: tidak ada pekerjaan ML yang jujur di sini. Jangan
> mengarang kebutuhan model untuk data yang tidak menuntutnya.**

### Tingkat 1 — butuh RIWAYAT TRANSAKSI per toko (deret waktu)

Ini pembuka terbesar. Dengan order per toko per periode:

| Kandidat | Nilai | Catatan |
|---|---|---|
| **Deteksi/prediksi dormansi** | **Tertinggi** | Langsung menjadi bahan bakar tuyul v0 (VISI §6.6) — satu-satunya bentuk tuyul yang lolos semua uji hukum & cakupan. Definisi baku Indonesia sudah ada: outlet *registered* yang nol transaksi melewati **3 call cycle** berturut |
| **Klasifikasi nilai outlet (ABC)** | Tinggi | Menjawab ketidakcocokan frekuensi-vs-nilai (VISI §3.3 "wawasan hari pertama") — tapi ini **pengurutan**, belum tentu butuh ML |
| **Prediksi permintaan per outlet** | Sedang | Menurunkan frekuensi dari nilai; ROADMAP §F sengaja menundanya |
| **Respons penjualan thd frekuensi** | Sedang | Ini yang membuat rekomendasi headcount bisa menjawab *"kalau tambah 1 sales, penjualan naik berapa?"* — lubang yang riset temukan belum dijawab VISI §5.2. **Butuh eksperimen, bukan cuma data observasional** |

#### 3.1 Rekomendasi cadence per toko — ⚠️ jebakan sebab-akibat

*Niat pemilik (2026-08-05): ML merekomendasikan toko ini layak mingguan /
dua-mingguan / bulanan / dua-harian — dan bahkan **harus hari Senin / Rabu**.*

Ini kelanjutan wajar dari ROADMAP §F (frekuensi sengaja dijadikan INPUT apa adanya)
dan VISI §5.5 (frekuensi sebagai tuas layanan). Tapi ia terbelah jadi dua soal yang
tingkat kesulitannya **sangat berbeda**.

**(a) SEBERAPA SERING — rawan, jangan dikerjakan naif.**

Data observasi akan menunjukkan toko berfrekuensi tinggi punya omset tinggi. Tapi
arahnya terbalik: frekuensinya tinggi **karena** tokonya besar, bukan sebaliknya.

Model yang dilatih di atas itu akan merekomendasikan "toko besar kunjungi lebih
sering" (melingkar, nol informasi) dan "toko kecil kurangi" — lalu **memenuhi
ramalannya sendiri**, karena toko yang jarang dikunjungi memang menurun. Itu bukan
model yang buruk; itu model yang mempelajari keputusan masa lalu, bukan realitas.

> **Syarat sebelum fitur ini boleh ada: variasi yang disengaja.** Ubah frekuensi
> pada sebagian toko secara acak, ukur akibatnya. Atau temukan eksperimen alami —
> perubahan rute yang dulu terjadi karena alasan lain (sales resign, wilayah dipecah).
> Tanpa salah satunya, ini korelasi yang menyamar jadi rekomendasi, dan orang
> mengambil keputusan bisnis di atasnya.

Catatan: klasifikasi ABC (mengurutkan toko menurut nilai) **tidak** butuh ML dan
tidak kena jebakan ini — ia deskriptif, bukan preskriptif. Kerjakan itu dulu.

**(b) HARI MANA — lebih mudah, dan lebih menarik.**

Berbeda dengan frekuensi, ini pola **di dalam satu toko** — tokonya jadi pembanding
bagi dirinya sendiri, jadi jauh lebih sedikit rancu. Alasannya nyata di lapangan:
hari pasar, siklus kehabisan stok, hari pemilik ada di tempat, siklus pembayaran,
persiapan akhir pekan. Semua terbaca dari pola waktu order.

⚠️ **Tapi ini KENDALA KERAS, bukan parameter.** Engine menentukan hari **murni dari
geografi** (`build_blocking` / `build_traffic` → K-Means). Toko yang dipaku ke hari
tertentu melawan pengelompokan itu:

- **sedikit** toko dipaku → aman: tempatkan yang dipaku dulu, klasterkan sisanya di sekitarnya
- **banyak** toko dipaku → compactness hancur, rute menyebar

**Setiap toko yang dipaku ada ongkosnya, dan ongkos itu harus DITAMPILKAN** — sejalan
dengan doktrin asumsi-melekat-pada-angka (VISI §5.8). Jangan biarkan user memaku 200
toko lalu heran kenapa rutenya jadi buruk.

#### 3.2 Nilai mampir (detour value) — separuhnya bisa dibangun SEKARANG

*Niat pemilik: untuk toko di luar rute hari ini, kalau salesman mampir ke yang
terdekat, tambahan omsetnya berapa?*

Terbelah rapi, dan belahannya berguna:

| Bagian | Butuh | Tingkat |
|---|---|---|
| **Ongkos mampir** — berapa meter/menit bertambah kalau toko disisipkan ke rute hari ini | murni geometri; `nn_tour` + `est_route_length` **sudah ada** | **0 — sekarang** |
| **Perkiraan tambahan omset** | riwayat order per toko | 1 |

Artinya *"toko ini 400 m dari jalur Selasa-mu"* bisa dikirim hari ini; *"dan nilainya
±Rp 2 juta"* menyusul.

Bedakan dua hal yang mudah tertukar: **mampir sekali** (oportunistik — reaktivasi,
prospek) vs **menambahkan permanen ke rute** (mengubah plan, mengubah beban, memicu
hitung ulang kapasitas). Yang pertama murah; yang kedua keputusan perencanaan.

#### 3.3 GABUNGAN 3.2 + tuyul v0 — bentuk terkuat dari seluruh konsep tuyul

> **Pelanggan dorman yang berjarak 400 m dari rute hari ini.**

- nilainya **diketahui** — riwayat order nyata, bukan taksiran benchmark penduduk
- lokasinya **diketahui** — sudah jadi pelanggan, koordinat sudah ada
- ongkos mampirnya **bisa dihitung** — geometri, hari ini juga
- **nol gerbang lisensi** — datanya milik sendiri, tak menyentuh Google/OSM/Overture
- konversinya lebih tinggi dari prospek dingin — pemiliknya sudah kenal

Ini menggabungkan VISI §6.6 (tuyul v0) dan §3.2 di atas jadi satu fitur yang lebih
kuat daripada keduanya sendiri-sendiri. **Kandidat terkuat untuk dikerjakan pertama
begitu riwayat transaksi tersedia.**

### Tingkat 2 — butuh JEJAK GPS kunjungan

| Kandidat | Catatan |
|---|---|
| **Model waktu tempuh** | Dari jejak nyata, per jam, per hari. Berpotensi **lebih baik dari OSRM** untuk geografi & gaya berkendara mereka sendiri |
| **Waktu layan nyata per toko** | Menopang langsung sumbu jam — satu-satunya pembeda lapis Simulasi yang tersisa |

⚠️ **Peringatan yang sudah terbukti:** praktisi Indonesia melaporkan *"GPS-nya
dimatikan, laporan diisi belakangan sekaligus"*. Jejak yang **dilaporkan sendiri**
tak bisa jadi sumber kalibrasi — itu memindahkan tebakan ke tempat yang tampak lebih
ilmiah. Hanya jejak **pasif** yang berguna, dan itu menuntut kendali atas aplikasi
lapangan — yang JKS tidak punya.

### Tingkat 3 — butuh data eksternal

Klasifikasi outlet dari citra (pola yang dipakai Bizom untuk dedup), pengayaan POI.
Terhalang gerbang lisensi & cakupan yang sudah didokumentasikan di VISI §6.7.

---

## 4. Kesimpulan strategis: yang memegang data transaksi memegang permukaan ML

JKS memegang **permukaan perencanaan**. Ia **tidak** memegang permukaan transaksi.

Hampir semua kandidat ML bernilai di tingkat 1 dan 2 menuntut data yang lahir di
sistem lain — DMS, SFA, aplikasi kunjungan. Tanpa umpan itu, peta ML ini tetap jadi
peta, bukan pekerjaan.

Dan di situlah **Zylem menarik**: seluruh bisnis mereka — dipatenkan di AS &
Afrika Selatan — adalah **menarik data secondary sales dari sistem billing
distributor secara otomatis, tanpa mengubah software di sisi distributor.** Itu
persis umpan yang membuka tingkat 1.

Ini juga menjelaskan kenapa tak ada pemain yang punya kapasitas berbasis jam yang
kredibel: **alat perencanaan dan alat ekstraksi data adalah perusahaan yang
berbeda.** Yang memegang rencana tidak memegang kenyataan, dan sebaliknya.

**Implikasi yang layak diuji, bukan diasumsikan:** kalau sebuah distributor sudah
memakai DMS/SFA, umpan datanya mungkin bisa diminta sebagai **ekspor berkala** —
bukan integrasi. Itu sejalan dengan pendirian "masukan lewat unggahan, bukan tarik
API" (tak ada permukaan integrasi yang harus dirawat), dan cukup untuk tingkat 1.
Satu pertanyaan ke distributor menjawabnya: **"bisakah Anda mengekspor riwayat order
per toko per bulan?"**

---

## 5. Yang JANGAN dikerjakan

- **Mengganti K-Means dengan neural combinatorial optimization.** Ada literaturnya
  (pointer network, attention model untuk VRP), jarang mengalahkan solver klasik di
  produksi, dan menukar keluaran yang bisa diterangkan baris-per-baris dengan yang
  tidak. Untuk pembeli yang sedang memutuskan menambah karyawan, **"bisa dijelaskan"
  mengalahkan "lebih optimal"** (VISI §5.3).
- **Menjadikan deteksi anomali koordinat sebagai ML.** Sudah berbasis aturan,
  sudah jalan, sudah bisa diterangkan.
- **Menaruh model apa pun di dalam `route_engine/`.** Lihat §2.
- **Memakai kata "AI" sebagai pesan jualan utama.** Semua pesaing sudah, tak satu
  pun menunjukkan isinya. Posisi yang lebih kuat: *"kami tidak menyebutnya AI — ini
  rumusnya, ini asumsinya, ini bagian yang kami belum yakin."*

---

## 6. Kalau nanti ML benar-benar masuk, syarat minimumnya

1. **Berjalan di lapis enrichment**, keluarannya berversi (§2)
2. **Versi model tercatat bersama angkanya**, sama seperti asumsi melekat pada
   angka di VISI §5.8 — *"waktu layan 12 menit (model v3, dilatih Agustus 2026)"*
3. **Ada garis dasar non-ML sebagai pembanding.** Kalau rata-rata sederhana sama
   baiknya, pakai rata-rata
4. **Bisa diuji mundur** terhadap sejarah pelanggan, seperti yang disyaratkan untuk
   kuantifikasi potensi (VISI §6.4)
5. **Boleh dimatikan.** Plan harus tetap bisa dibuat kalau modelnya tak tersedia —
   dengan angka asumsi manual, seperti sekarang
