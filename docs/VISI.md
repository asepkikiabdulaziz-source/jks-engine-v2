# Visi Produk — dari tool internal ke platform perencanaan teritori FMCG

> Ditulis: 2026-08-04 (sesi 13) · **STATUS: BELUM DIKUNCI**
> Dokumen ini merekam **keputusan rancangan beserta alasannya**, bukan rencana kerja.
> Tidak ada tanggal, tidak ada estimasi, tidak ada urutan yang mengikat.
>
> Hubungan dengan `ROADMAP.md`: ROADMAP masih menggambarkan peta jalan **tool
> internal** (item A–F) dan kini **usang sebagian**. Contoh paling jelas: item E
> (OSRM) di sana tertulis *"capstone, bisa dikerjakan kapan saja"* — dalam visi ini
> ia naik jadi syarat kredibilitas. ROADMAP baru ditulis ulang **setelah** arah ini
> dikunci, bukan sebelumnya.
>
> **↑ Sudah terjadi lebih cepat dari rencana itu — 2026-09-02, dan arah ini MASIH belum
> dikunci.** Pemicunya bukan arah produk melainkan kejadian di luar keduanya: 2026-08-05
> nabati-heroes menghapus 17 RPC JKS dari `public` (migrasi `0525` mereka) dan aplikasi
> produksi mati. ROADMAP lama menjadwalkan pekerjaan di atas fondasi yang sudah tidak ada,
> jadi menunggu penguncian berarti membiarkannya menyesatkan. ROADMAP baru menyelesaikan
> tegangan itu dengan **memisahkan** yang wajib di setiap cabang (Fase 0–1: DB baru, auth,
> data, utang mematikan) dari yang bergantung arah (Fase 2, ditulis sebagai **dua cabang
> berdampingan** — tidak dipilih di sana). Jadi dokumen ini tetap yang memutuskan arah;
> ROADMAP tidak mendahuluinya.

---

## 1. Perubahan arah

Dari **tool internal Nabati** menjadi **platform publik** yang bisa didaftari siapa
pun, difokuskan ke **niche distribusi FMCG Indonesia**.

**Kenapa niche, bukan tool teritori umum.** Kekuatan produk ini adalah ia
*berpendirian*: dua filosofi bernama (BLOCKING/TRAFFIC), pola siklus M1/M2C13/M2C24,
determinisme, manusia-dalam-lingkar. Setiap satu dari itu adalah **asumsi**.
Menggeneralisasi berarti melarutkan asumsi, dan yang tersisa adalah tool tanpa
pendapat yang bersaing di lapangan pemain mapan. Generalitas bukan penambahan —
ia pengurangan yang menyamar.

Lawan yang sesungguhnya bukan Salesforce Maps atau eSpatial. **Lawannya spreadsheet.**

**Nabati jadi tenant #1**, bukan kasus khusus. Konsekuensinya: DB pindah penuh
(project sendiri, auth sendiri). Gagasan "shortcut dari aplikasi Heroes" **gugur** —
ia kontradiktif dengan pendaftaran terbuka.

---

## 2. Bentuk: mulai dari 0, DNA engine dipertahankan

Terukur (2026-08-04): `route_engine/` (~1.300 baris) punya **nol** import Supabase
dan **nol** rujukan `area_id`/`kd_dist`/`cabang`. Tiga kopling tersisa semuanya
kosmetik: `div_sls` sebagai label, `gadm_region` di QC (konsepnya generik), nama
hari Indonesia.

Bandingkan: `api.py` 60 rujukan konsep Nabati, `PlanMapPage` 25, `RoutingEnginePage`
23. **~15% kode selamat hampir utuh; ~85% cangkang ditulis ulang.**

**Yang ikut sebagai DNA:**

1. `route_engine/` — dipindah, bukan ditulis ulang
2. **21 test acceptance-nya** — ini yang membuktikan perilaku tetap identik setelah
   pindah. Bukan kelengkapan; tali pengaman seluruh migrasi
3. Doktrin: fail-loud, tanpa fallback senyap, determinisme byte-per-byte
4. Dua filosofi BLOCKING/TRAFFIC
5. "Engine merekomendasi, manusia memutuskan"

**Yang untung dibuang:** `_build_from_territories` (duplikasi logic engine di
transport layer, dan Path A-nya melewati QC + summary), 15 RPC `SECURITY DEFINER`,
kopling `mst_area`, monolit 2.420 baris.

**Aturan teknis:** `route_engine/` jadi **satu paket terpasang**, jangan disalin.
Dua salinan akan menyimpang dalam hitungan bulan dan DNA-nya justru bercabang —
persis hal yang mau dihindari.

**Generalisasi murah vs mahal:**

| Sumbu | Ongkos | Keputusan |
|---|---|---|
| Hierarki wilayah | murah (tabel node parent-child, ~20%) | **generalisasi sejak awal**, onboarding buat template depo→teritori→sales |
| Cadence, filosofi, asumsi rute | mahal (menyentuh engine + UI adjustment) | **tetap berpendirian** |

---

## 3. Tiga lapis

Berurutan sesuai cara keputusan sungguhan diambil — dari strategis ke operasional.

| Lapis | Pertanyaan | Yang memutuskan | Irama |
|---|---|---|---|
| **Potensi** | Ke mana kami tumbuh? | pemilik / manajemen | tahunan |
| **Simulasi** | Butuh berapa orang? | manajemen / kepala cabang | kuartalan |
| **Perencanaan** | Siapa ke mana, hari apa? | supervisor | bulanan |

⚠️ **Penamaan:** JANGAN pakai "tahap 1 / tahap 2". `/stage1` dan `/stage2` **sudah
ada di kode** dengan arti berbeda (partisi sales / penjadwalan hari), ditambah state
machine `DivStage` (`s1_running`, `s2_preview`, …). Pakai nama yang menjelaskan
sifatnya — **Potensi / Simulasi / Perencanaan**. Murah sekarang, mahal setelah
tertulis di endpoint, tabel, dan kepala orang.

---

## 4. Lapis PERENCANAAN — engine yang sekarang

Tidak berubah. Partisi → iris hari → 6×2 → adjustment manual. 21 test tetap berlaku.
Risikonya terhadap yang sudah terverifikasi: **nol**.

Satu tambahan yang datang dari lapis Potensi: **sasaran akuisisi di sepanjang jalur**
(lihat §6).

---

## 5. Lapis SIMULASI — inversi urutan kerja

### 5.1 Inversi

**Sekarang:** user memasukkan `n_sales` → engine membagi jadi sekian wilayah.
**Nanti:** engine menghitung → *"dengan kondisi toko dan kapasitas ini, disarankan
sekian sales."*

Alasannya bukan kenyamanan: **itu pertanyaan bisnis yang sesungguhnya.** Distributor
tidak tahu dia butuh berapa salesman. Menyuruhnya menebak `n_sales` lebih dulu
berarti menyuruhnya menjawab pertanyaan yang justru ingin dia tanyakan.

### 5.2 Kapasitas dari jam kerja — dan kapasitas adalah KELUARAN

```
8 jam  =  N × waktu_layan  +  panjang_rute ÷ kecepatan
```

- **waktu layan per toko** — mereka tahu (10–15 menit)
- **panjang rute** — **sudah ada**: `est_route_length`, haversine × `road_factor` (1.3)
- **kecepatan rata-rata** — asumsi mereka

Kapasitas per hari **berbeda-beda antar wilayah** karena geografinya berbeda. Itu
hasil perhitungan, bukan angka datar yang diminta di awal.

Bisa dibangun **tanpa OSRM**, syaratnya: setiap faktor konversi diisi user dan
terlihat di layar. Ketidakjujuran bukan pada mengestimasi — ketidakjujuran adalah
menyembunyikan bahwa itu estimasi.

### 5.3 Lingkaran: jangan dipecahkan, tampilkan

> kapasitas → panjang rute → partisi → `n_sales` → kapasitas

Godaannya adalah iterasi otomatis sampai konvergen. **Jangan.** Sebagai gantinya:

1. Hitung `n` kasar dari aritmetika sederhana
2. Partisi seperti biasa (**engine tak berubah**)
3. Ukur tiap blok (sales, hari): `N × layan + rute ÷ kecepatan` = perkiraan jam
4. Tunjukkan blok mana yang melewati garis 8 jam
5. User geser `n`, langsung lihat akibatnya

Deterministik, bisa diterangkan baris per baris, dan lingkarannya ditutup manusia.
Algoritma konvergensi otomatis akan rapuh dan mustahil dijelaskan ke orang yang
sedang memutuskan merekrut.

### 5.4 Bentuknya what-if, bukan rekomendasi

Ini memindahkan kepemilikan klaim:

- *Rekomendasi*: "Anda butuh 10 sales" → **kamu** memikul klaimnya
- *What-if*: "kalau 10 sales, beginilah jadinya" → **mereka** memiliki keputusannya

Bebannya hilang, kejujurannya naik, nilainya justru bertambah. Ini bentuk paling
murni dari "engine merekomendasi, manusia memutuskan" di seluruh produk.

**Keluarannya kurva, bukan satu angka:**

| Sales | Est. jam/hari | Blok lewat 8 jam |
|---|---|---|
| 8 | 9,8 | 71% |
| 10 | 7,9 | 22% |
| 12 | 6,6 | 4% |

Manajemen tidak sedang mencari kebenaran; mereka menimbang **biaya vs layanan**.
Menyodorkan satu angka menyembunyikan bahwa ini keputusan penilaian.

**Jangkarnya keadaan mereka sekarang**, bukan optimum abstrak. Skenario pertama yang
selalu tampil = jumlah sales yang mereka punya hari ini. *"Tambah 2 orang, lembur
turun dari 71% ke 22%"* jauh lebih mudah diterima daripada *"konfigurasi optimalnya 12"*.

### 5.5 Tuas what-if

Jelas: jumlah sales, hari kerja, jam kerja, waktu layan, kecepatan, filosofi
(BLOCKING/TRAFFIC — **sudah ada**).

Dua yang paling berharga dan mudah terlewat:

- **Frekuensi sebagai tuas tingkat layanan** — *"kalau toko kelas A naik ke mingguan,
  tambah berapa sales?"* Menukar biaya dengan kedekatan ke toko besar.
- **Cakupan sebagai tuas ekspansi** — *"kalau buka 300 toko baru di Bekasi, tambah
  berapa?"*
- **Stabilitas sebagai tuas** — lihat §8.2.

Semuanya jalan di atas mesin yang sama. Tidak ada kode engine tambahan.

### 5.6 Kenapa ini boleh jalan sebelum OSRM

Bias haversine bersifat **sistematis** (optimistis di kota, konsisten searah).

Untuk **angka mutlak** itu masalah. Untuk **perbandingan antar-skenario**, bias
sistematis sebagian besar **saling meniadakan** — *"12 sales 20% lebih ringan dari
10"* tetap bertahan walau estimasi tempuhnya meleset seragam.

Maka: sajikan **perbandingan** sebagai yang utama, angka mutlak sebagai konteks,
selalu berlabel estimasi.

### 5.7 Skenario ≠ Plan

Plan itu operasional (dieksekusi salesman, punya status DRAFT/APPROVED). Skenario
itu bahan keputusan — disimpan berdampingan, dibandingkan, dibawa ke rapat, lalu
sebagian besarnya dibuang. **Model data dan siklus hidupnya berbeda. Jangan
dipaksa masuk tabel `plans`.**

### 5.8 Angka tidak boleh bepergian sendirian

Keluaran simulasi akan dicetak dan dibawa ke rapat anggaran. Begitu lepas dari
layarnya, "10 sales" gampang berubah jadi kebenaran mutlak.

Asumsinya harus **melekat pada angkanya** di setiap ekspor — satu baris di sebelahnya,
bukan catatan kaki:

> *10 sales — asumsi 10 menit/toko, 20 km/jam, 8 jam/hari, frekuensi per 4 Agustus 2026.*

---

## 6. Lapis POTENSI — menangkap peluang, bukan cuma kondisi

### 6.1 Kenyataan keras yang harus di depan

**Engine tidak bisa melihat apa yang tidak ada di datanya.** Whitespace = wilayah
dengan nol toko di database. Clustering atas toko yang ada tak akan pernah tahu isi
lubangnya — ia hanya tahu lubangnya ada.

Maka ini **dua kemampuan berbeda dengan tingkat kepercayaan yang sangat berbeda.**
Menggabungkannya adalah cara tercepat merusak kredibilitas.

### 6.2 Deteksi whitespace — bisa sekarang, nol karangan

Bahannya sudah ada di DB: `gadm_regions` (77.473 desa), `gadm_kecamatan` (6.695
poligon), titik toko. Tumpangkan:

> *"Kecamatan X: 0 toko terdaftar. Enam kecamatan berbatasan rata-rata 45 toko."*

Pernyataan **geometris**, seluruhnya dari data mereka. Tanpa asumsi, tanpa estimasi.
Dan sudah cukup membuat pemilik distributor duduk tegak.

### 6.3 Pertanyaannya UJI AMBANG, bukan uji presisi

Ini yang menentukan seberapa teliti datanya harus.

Pertanyaan sebenarnya **bukan** *"berapa persis potensi kecamatan ini?"* melainkan:

> **"Cukup tidak untuk menghidupi satu salesman?"**

Itu perbandingan terhadap **titik impas**, bukan pengukuran:

```
ambang  =  biaya salesman/bulan ÷ margin
        =  Rp 8 juta ÷ 15%  =  ±Rp 53 juta omset/bulan

temuan  =  ±300 toko × omset rata-rata  =  ±Rp 100 juta/bulan
```

Rp 100 juta vs ambang Rp 53 juta → **layak, dengan ruang aman ±2×**. Kesimpulan itu
**tetap bertahan walau taksirannya meleset 30%.**

**Konsekuensinya besar:** ketelitian yang dibutuhkan **ditentukan oleh jarak ke
ambang, bukan oleh keinginan akurat.** Data referensi kasar sudah memadai — asalkan
jawabannya tidak berimpit dengan ambang. Untuk membedakan "300 toko" dari "20 toko",
data kasar lebih dari cukup.

**Maka keluarannya tiga keadaan, bukan satu angka:**

| Keadaan | Artinya |
|---|---|
| **Layak** | jauh di atas ambang — aman walau taksiran meleset |
| **Tidak layak** | jauh di bawah — jangan buang survei ke sini |
| **Terlalu dekat untuk dipastikan** | berimpit dengan ambang → **survei lapangan dulu** |

Keadaan ketiga itu yang membuat fitur ini jujur. Alat yang selalu memberi angka pasti
sedang berbohong; alat yang tahu kapan ia tidak tahu bisa dipercaya. Dan justru
keadaan ketiga inilah yang paling berguna secara operasional — ia mengarahkan biaya
survei ke tempat yang benar-benar butuh diperiksa.

⚠️ **Ambangnya harus memperhitungkan ramp** (§6.4, butir 4). Pertanyaan sesungguhnya
bukan *"apakah wilayah ini akhirnya melewati ambang"* tapi *"apakah ia mencapainya
dalam jumlah bulan yang bisa diterima"*.

### 6.4 Kuantifikasi potensi — butuh data luar, metodenya transfer benchmark

```
Kecamatan tergarap : 45 toko ÷ 52.000 penduduk = 0,87 per 1.000
Kecamatan kosong   : 38.000 penduduk × 0,87    = ±33 toko potensial
                     × omset rata-rata toko sebanding = potensi omset
```

Data penduduk (BPS) adalah **tabel referensi statis** — bentuknya persis sama dengan
GADM yang sudah diimpor lewat `scripts/import_gadm.py`. **Determinisme tetap utuh**;
engine tidak jadi memanggil API eksternal.

**Empat hal yang wajib jujur disebut:**

1. **Kosong belum tentu peluang.** Bisa dikunci kompetitor, hutan, kawasan industri,
   kesepakatan batas antar-distributor. Engine tak bisa membedakan "belum" dari
   "tidak bisa" → keluarannya **kandidat untuk dinilai manusia**, bukan kesimpulan.
2. **Penduduk ≠ daya beli.** Butuh proksi urban/rural, atau terima galatnya.
3. **ROI wajib pakai MARGIN, bukan omset — angka paling berbahaya di seluruh produk.**
   `ROI = (potensi omset × margin) − (gaji + insentif + motor + BBM)`. Margin dan
   biaya **harus mereka yang isi**; jangan pernah ditebak.
4. **Waktu ramp.** Wilayah baru tak mencapai potensi di bulan pertama. ROI tanpa ramp
   adalah fiksi.

**Uji mundur sebelum ditunjukkan ke pelanggan mana pun:** ambil wilayah yang mereka
ekspansi 2 tahun lalu, jalankan model seolah berdiri sebelum ekspansi, bandingkan
prediksi vs kenyataan. Meleset jauh → kamu tahu duluan. Dekat → itu bahan penjualan
terkuat yang bisa ada.

### 6.5 "Tuyul" — mesin menyisir, manusia membujuk

Penelusuran otomatis menemukan toko yang **ada secara fisik tapi belum jadi
pelanggan**. Hasilnya jadi **sasaran akuisisi** yang disodorkan ke salesman:
*"ada toko di situ, 200 meter dari rute Selasa-mu."*

Ini mengubah whitespace dari perkiraan statistik jadi **daftar nama berkoordinat**.

**Pembeda yang sulit ditiru:** alat pencari prospek tahu ada toko di sana, tapi
**tidak tahu rutemu**, jadi tak bisa tahu mana yang gratis dihampiri. Kandidat 200
meter dari jalur yang memang sudah dilewati punya biaya kunjungan tambahan nyaris
nol. Wawasan ini **hanya bisa keluar dari mesin yang memegang rute**.

**Pembagian kerja:**

> Mesin mengerjakan yang membosankan (menyisir, mencocokkan, memfilter).
> Manusia mengerjakan yang tak tergantikan (membujuk pemilik toko).
> Insentif menyambung keduanya.

**Kelangkaan itu rancangan, bukan batasan teknis.** 40 prospek → diabaikan semua.
**2 prospek**, dengan nama dan foto → dikerjakan. Urut berdasarkan jarak dari rute +
ukuran toko + kepadatan pelanggan sekitar, lalu **potong di angka kecil**.

### 6.6 Tuyul v0 — pelanggan yang kabur

**Jalankan ini duluan.** Sasaran yang 100% milik mereka sendiri:

> Toko yang dulu pelanggan, berhenti order 6 bulan terakhir.

Tanpa ToS, tanpa crawling, **tanpa masalah pencocokan** (sudah punya
`customer_code` + koordinat + riwayat). Konversinya jauh lebih tinggi daripada
prospek dingin — pemiliknya sudah kenal dan alasan berhentinya sering sepele.

Dan **nilainya diketahui**: *"toko ini dulu order 4 juta/bulan"* adalah angka nyata,
bukan taksiran benchmark. Prioritasnya bisa dihitung sungguhan.

### 6.7 Tuyul eksternal — ToS adalah gerbangnya

⚠️ **Harus diperiksa serius SEBELUM dibangun di atasnya.**

| Sumber | Cakupan warung kecil ID | Boleh disimpan? |
|---|---|---|
| Google Places | terbaik | ⚠️ pembatasan penyimpanan / basis data turunan — **verifikasi ketentuan terkini** |
| OpenStreetMap | jarang (minimarket ada, toko kelontong tidak) | ya, ODbL — perhatikan share-alike |

Masalahnya bukan memanggil API-nya, tapi **menumpuk hasilnya jadi aset permanen** —
dan justru itu yang dibutuhkan model ini.

### 6.8 Pencocokan: bagian teknis yang akan menggigit

Persoalan sulitnya bukan mendapat daftar POI, tapi menjawab **"apakah POI ini sudah
pelanggan kami?"**. Nama tak pernah sama persis (*"Toko Bu Siti"* / *"TK BU SITI"* /
*"Warung Siti"*), koordinat meleset 20–50 m, dua warung bisa berdampingan.

**Akibat salahnya asimetris:**

- **Salah positif** (kandidat ternyata pelanggan lama) → salesman menawarkan jadi
  pelanggan ke orang yang sudah langganan 3 tahun. Kepercayaan ke sistem langsung
  hilang.
- **Salah negatif** → peluang terlewat, diam-diam.

Yang pertama jauh lebih merusak → **ambang condong ke aman, kecocokan ragu-ragu
dilempar ke penilaian manusia**, jangan diputuskan otomatis.

### 6.9 Empat tombol yang menutup lingkaran

`Jadi pelanggan` · `Belum mau` · `Tokonya tidak ada` · `Sudah langganan orang`

Menempel pada tindakan **berkomisi**, jadi ikut terbawa sesuatu yang mereka pedulikan
— bukan tugas administratif tersendiri.

Tiap jawaban bekerja dua arah: membersihkan basis prospek, **dan menilai kualitas
tuyulnya**. *"Tokonya tidak ada"* yang sering muncul = sumber data basi, dan kamu
tahu sebelum pelanggan mengeluh.

### 6.10 Kenapa ini satu-satunya bagian yang berbunga

Data POI mentah bisa dibeli siapa saja. Data POI **yang sudah dianotasi hasil nyata**
— mana yang benar ada, mana yang konversi, berapa lama, siapa yang berhasil — tidak
bisa disalin. Ia menumpuk tiap hari dan hanya milik kamu.

---

## 7. Kendala manusia — yang mengikat, bukan optimalitas

**Salesman secara natural malas.** Ini bukan penilaian moral, ini fakta rancangan
insentif: mereka dibayar atas penjualan, bukan atas kepatuhan atau kualitas data.
Apa pun yang tidak membantu mereka mencapai target = gesekan.

> **Rencana terbaik bukan yang paling optimal, tapi yang paling mungkin dijalankan.**

Plan yang 5% lebih efisien tapi membuat hari mereka terasa lebih berat akan
diabaikan, dan efisiensinya nol. Sebagian besar literatur optimasi mengabaikan ini
karena mengasumsikan rencana dieksekusi.

**Konsekuensinya:**

- **Compactness adalah fitur adopsi**, bukan estetika peta. Rute rapat = lebih sedikit
  berkendara di bawah matahari — satu-satunya fitur di produk ini yang menguntungkan
  salesman secara langsung, hari itu juga. **Pertahankan mati-matian**, dan katakan
  terang-terangan saat menjual. (ROADMAP §F memilih compactness di atas balance dengan
  alasan keterbacaan; alasannya ternyata lebih kuat dari yang tertulis.)
- **Jangan minta data — bayar hasil.** Tombol "toko baru" gagal karena tak ada
  imbalannya. Toko baru yang terdaftar **dan menghasilkan order pertama** = komisi →
  datanya datang sebagai produk sampingan insentif yang memang selaras.
- **Ukur yang sulit dipalsukan.** GPS pasif > tap check-in. Data order > laporan
  kunjungan. Apa pun yang dilaporkan sendiri tentang usaha akan dioptimalkan melawan
  pengukurnya — itu respons wajar terhadap insentif, bukan kecurangan.
- **Salesman adalah SUBJEK rencana, bukan penggunanya.** Penggunanya supervisor.
  Jangan bangun fitur yang mengandalkan keterlibatan salesman. Yang mereka terima
  cukup satu: **daftar hari ini, sesederhana mungkin, lebih ringan dari sebelumnya.**
  Semua kecanggihan menghadap ke atas.

**Pertanyaan terbuka yang mengubah bentuk fitur akuisisi:** *"Siapa yang membuka toko
baru di tempat Anda — sales yang sama, atau orang lain?"* Banyak distributor memisahkan
sales **maintenance** dan sales **development**. Kalau terpisah, sasaran akuisisi bukan
tambahan di lembar rute harian melainkan pekerjaan orang lain — dan simulasi headcount
punya **dua jenis sales** dengan kapasitas dan tujuan berbeda.

---

## 8. Ide yang belum masuk lapis mana pun

### 8.1 Umpan balik rencana vs realisasi

Kalau ada SFA, sistem tahu ke mana salesman **benar-benar** pergi dan apa yang
**benar-benar** terjual. Bandingkan → kepatuhan, **kalibrasi kapasitas dengan waktu
tempuh nyata**, dan bukti dampak.

Yang kedua besar: **jejak GPS mereka sendiri lebih baik daripada OSRM** untuk
keperluan ini. OSRM memberi rute jalan generik; jejak nyata memberi *"berapa lama
salesman kami, naik motor, jam 10 pagi, dari toko A ke B"* — termasuk macet, parkir,
dan kebiasaan setempat.

⚠️ **Syarat:** jejaknya harus **pasif**. Kalau check-in manual, ia akan di-check-in
dari warung sebelah atau diborong sore hari (§7). Kalibrasi dari data begitu bukan
kalibrasi — itu memindahkan tebakan ke tempat yang tampak lebih ilmiah.

### 8.2 Biaya perpindahan wilayah

ROADMAP menyatakan *"engine = perencana dari-0, bukan optimizer operasi berjalan"*.
Benar untuk perencanaan **pertama**. Untuk yang **kedua dan seterusnya**, memindahkan
toko antar salesman ada ongkosnya: hubungan putus, salesman baru tak kenal pemilik,
piutang rancu.

Plan ulang seharusnya **meminimalkan perpindahan** relatif ke keadaan sekarang.
*"Tambah 1 sales dengan memindahkan 180 toko"* vs *"…340 toko"* sangat berbeda bagi
yang menjalankannya, meski peta akhirnya sama bagusnya.

### 8.3 Skenario musiman (Ramadan)

Ramadan mengubah segalanya di FMCG Indonesia: volume melonjak, jam buka bergeser,
pasar tradisional beda ritme, Lebaran menghentikan beberapa hari. Distributor
menanganinya dengan improvisasi tiap tahun.

What-if musiman menjawab pertanyaan yang berulang tiap tahun dan tak pernah punya
alat. **Tool asing tidak akan pernah membangun ini** — justru itu gunanya memilih niche.

### 8.4 Dua kendala dunia nyata

- **Rumah salesman sebagai jangkar.** Engine sekarang cuma tahu depo. Sales yang
  tinggal di utara tapi dapat wilayah selatan kehilangan sejam sebelum mulai kerja.
  Murah ditambahkan, langsung terasa oleh orangnya.
- **Jendela waktu.** Pasar tradisional tutup siang. Wilayah VRP klasik — **jangan
  dikerjakan lebih awal**, kerumitannya naik banyak. Cukup dicatat, dan tanyakan ke
  calon apakah ini nyata atau cuma teori.

---

## 9. Ketergantungan yang berubah statusnya

| Hal | Status lama | Status dalam visi ini |
|---|---|---|
| **`visit_frequency`** | cacat kosmetik, ditunda | **PRASYARAT.** Begitu headcount diturunkan dari beban, toko mingguan = 2× beban dua-mingguan. Salah baca → rekomendasi sales **separuh** dari yang dibutuhkan. Itu bukan flag di pojok layar, itu angka yang dipakai orang merekrut. Detail: [pilot/README §6](pilot/README.md) |
| **OSRM (ROADMAP E)** | "capstone, bisa kapan saja" | Naik peringkat, **tapi sifatnya berubah**: bukan soal rute yang enak dilihat, melainkan **kredibilitas angka yang dipakai merekrut**. Mungkin sebagian tergantikan §8.1 |
| **Balance jarak/waktu (§F)** | ditunda sampai pasca-OSM | Terbuka kembali begitu beban terukur dalam **jam** — persis seperti §F perkirakan |
| **Isolasi antar-tenant** | tak relevan (1 user) | **Struktural dan teruji.** Satu kesalahan membocorkan daftar toko Perusahaan A ke B = fatal komersial |
| **Fail-loud FE** | utang yang menyebalkan | **Mematikan.** Empty-state palsu di onboarding self-serve = pelanggan hilang tanpa jejak |
| **Whitespace sbg sinyal (§F)** | catatan pinggir ("jangan diratakan paksa") | **Fitur utama.** Bukan belokan arah — kelanjutan yang konsisten |

---

## 10. Yang BELUM diputuskan

1. Sumber data POI eksternal, setelah ketentuan Google diperiksa
2. Siapa yang melakukan akuisisi — sales yang sama atau peran terpisah (§7)
3. Unit yang dijual: per depo, per slot sales, atau per toko
4. Apakah lapis Potensi dijual terpisah (sekali bayar, sekelas konsultan) dari
   Perencanaan (langganan operasional)
5. Kapan tes distributor dijalankan — paketnya siap (`docs/pilot/`), sengaja ditunda
   karena ia menguji **komponen**, bukan proposisi barunya

---

## 11. Apa yang akan mengubah dokumen ini

Ditulis dari penalaran dan pengetahuan domain, **belum dari pelanggan**. Yang paling
mungkin menjatuhkan bagian-bagiannya:

- **Distributor tak punya koordinat toko** → seluruh dasarnya goyah; geocoding jadi
  prasyarat produk, bukan fitur
- **Cakupan POI terlalu jarang untuk warung kecil** → §6.5–6.8 mengecil jadi §6.6
  (pelanggan kabur) saja
- **Ketentuan Google melarang basis data turunan** dan OSM terlalu jarang → tuyul
  eksternal mati; yang tersisa data milik sendiri
- **Estimasi jam meleset jauh dari kenyataan** → simulasi kehilangan kredibilitas
  sampai ada data tempuh nyata (§8.1) atau OSRM
- **Akuisisi ternyata peran terpisah di mana-mana** → fitur "sasaran di sepanjang
  rute" kehilangan sebagian besar nilainya

Perbarui dokumen ini saat salah satu terjawab — **termasuk saat jawabannya
mengecewakan.** Dokumen visi yang cuma berisi sisi baiknya tidak berguna.
