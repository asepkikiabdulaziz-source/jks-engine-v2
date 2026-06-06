# Audit Menyeluruh — JKS Route Engine v2

> **Tanggal:** 2026-06-06
> **Metode:** 5 audit paralel (keamanan/otorisasi, higiene kredensial, kualitas frontend, kepatuhan filosofi engine, dependency/build/deploy) + **verifikasi independen** atas setiap klaim severity-tinggi.
> **Prinsip audit:** temuan berbasis bukti (path:line), severity dikalibrasi, false-alarm dikoreksi terbuka. Klaim yang tak terverifikasi ditandai eksplisit.

## Postur keseluruhan

Engine inti **matang & patuh filosofi** (diperkuat kerja sesi pembalikan prinsip "crash > menyimpang"). Risiko nyata terkonsentrasi di **lapisan API backend (otorisasi)** dan **kesiapan deployment**. Frontend solid dengan beberapa celah error-handling. **Tidak ada secret yang bocor ke git.**

| Severity | Jumlah | Area dominan |
|----------|--------|--------------|
| 🔴 Critical | 1 | Otorisasi API |
| 🟠 High | 2 | Auth engine, CORS |
| 🟡 Medium | 8 | Authz DB (unverified), validasi input, determinisme deps, penyimpangan senyap, error-handling FE |
| 🟢 Low | 6 | Kesiapan deployment, docs, UX |

---

## 🔴 CRITICAL

### C1 — Tidak ada otorisasi area/depot di API backend
- **Lokasi:** `api.py` — endpoint `/generate-plan`, `/stage1`, `/stage2`
- **Verifikasi:** terbukti 3× — audit keamanan, audit addendum platform, dan grep langsung (`get_my_profile|scope_id|allowed_depot|assert_depot|403` di `api.py` → **nol match**).
- **Deskripsi:** endpoint hanya memverifikasi JWT lalu mengekstrak `user_id`. Tidak ada cek apakah user berhak atas `area_id`/`kd_dist` yang dikirim. Jalur engine memakai **service role key** (bypass RLS) sehingga tidak ada jaring pengaman lapis-DB.
- **Dampak:** user mana pun dengan JWT valid dapat generate/baca plan untuk area/cabang mana pun bila tahu UUID-nya. Akses lintas-area penuh.
- **Aksi:** tambah guard otorisasi (cek scope user dari profil) sebelum `engine.run()`. Lihat juga addendum platform §2 (RBAC `get_allowed_depots` / `assert_depot_access`).

---

## 🟠 HIGH

### H1 — `X-Engine-Secret` dikirim tapi tidak divalidasi
- **Lokasi:** dikirim di `supabase/functions/generate-plan/index.ts:115`; **tidak ada** validasi di `api.py`.
- **Verifikasi:** grep `api.py` → nol. Sudah didokumentasikan sebagai utang di `TECHNICAL.md:592` ("ROUTE_ENGINE_SECRET … belum diimplementasikan di api.py").
- **Dampak:** bila engine deploy ke IP publik, endpoint komputasi-berat (K-Means) tanpa lapis pertahanan kedua → abuse/DoS.
- **Aksi:** validasi `ROUTE_ENGINE_SECRET` via FastAPI dependency di semua endpoint berat.

### H2 — CORS `allow_origin_regex` localhost ikut ke semua environment
- **Lokasi:** `api.py:61-69`
- **Deskripsi:** `allow_origin_regex=r"http://localhost:\d+"` + `allow_credentials=True` hardcoded, tidak dibedakan dev vs prod.
- **Dampak:** di produksi, origin localhost mana pun dapat memanggil API dengan credentials.
- **Aksi:** nonaktifkan regex localhost saat `ENVIRONMENT=production`; set `allow_origins` ke domain asli saja.

---

## 🟡 MEDIUM

| ID | Temuan | Lokasi | Catatan / Aksi |
|----|--------|--------|----------------|
| M1 | **RLS/RPC authorization belum terverifikasi** | DB Supabase (di luar repo) | Definisi RPC SECURITY DEFINER ada di DB. Karena API tak punya authz (C1), batas keamanan baca-frontend **sepenuhnya** bergantung apakah RPC cek scope internal — **belum terbukti**. Verifikasi via security advisor + inspeksi policy. |
| M2 | Input tak dibatasi: `depo_lat/lon` tanpa bound; `divisions` & `customer_codes` tanpa `max_items` | `api.py` (model request) | Risiko DoS (mis. 10.000 divisi) / koordinat ekstrem. Catatan: `n_sales` & `work_days` **sudah** dibatasi. Tambah bound lat/lon (-90..90 / -180..180) + `max_items`. |
| M3 | `requirements-api.txt` pakai `>=` (tak di-pin) | `route_engine/requirements-api.txt` | Inkonsisten dengan determinisme yang ditegakkan di `requirements.txt`. Pin ke `==`. |
| M4 | `python-dotenv` di-import tetapi tak dideklarasikan + fallback senyap | `start_engine.py` | **Pola "fallback senyap" yang dilarang spec §2** (lihat kerja sesi ini). Deklarasikan sebagai dependency + gagal jelas bila absen. |
| M5 | `balance_criterion=ROUTE_LENGTH` diterima tapi **diam-diam diperlakukan COUNT** | `route_engine/core/partition.py` | **Penyimpangan senyap** — anti-pola yang baru diberantas di engine. Minimal tolak eksplisit bila belum didukung. |
| M6 | Model lock TRAFFIC = BLOCKING (dua lock), padahal spec §4B = satu lock | `route_engine/engine.py` (Plan class) | `lock_territory()` tak bermakna di TRAFFIC; tak ada validasi philosophy-specific. Juga: `# TODO confirm` granularitas adjust TRAFFIC (§12) belum ada di kode. |
| M7 | RPC tanpa `.catch()`; `Promise.all` tanpa catch | `src/context/AreaContext.tsx:51-74`, `src/pages/DashboardPage.tsx:239` | Dropdown/area kosong senyap saat network error. Tambah handler + state error. |
| M8 | Race condition double-click "Generate Jadwal" | `src/pages/RoutingEnginePage.tsx:1357` | Dua fetch overlap → state korup. Disable tombol saat request in-flight. |

---

## 🟢 LOW

| ID | Temuan | Lokasi | Aksi |
|----|--------|--------|------|
| L1 | `.dockerignore` tidak ada → `__pycache__`/`tests` ikut ter-copy (bloat) | root | Tambah `.dockerignore`. *Koreksi dari klaim "Critical": Dockerfile pakai `COPY` bertarget, bukan `COPY . .`, jadi `.env`/`.git`/`node_modules` **tidak** ikut.* |
| L2 | Dockerfile tanpa `HEALTHCHECK` | `route_engine/Dockerfile` | Tambah healthcheck ke `/health`. |
| L3 | Tak ada global exception handler; `_verify_jwt` bocorkan detail exception | `api.py` (`f"Unauthorized: {exc}"`) | Generik-kan pesan; tambah handler global. |
| L4 | `.env.example` tidak ada | root | Buat template onboarding (tanpa nilai rahasia). |
| L5 | Edge Function `generate-plan` redundan & kontraknya drift dari `api.py` | `supabase/functions/generate-plan/index.ts` | Hapus atau sinkronkan + tandai deprecated. |
| L6 | Error tak di-clear saat retry stage1; `any` di `markerRef` | `src/pages/RoutingEnginePage.tsx:1293`, `src/pages/PlanMapPage.tsx:112` | Reset `error:undefined`; ketik `L.Marker`. |

---

## ⚪ False alarm / severity dikoreksi (transparansi)

| Klaim subagen | Verdict | Bukti |
|---------------|---------|-------|
| "CRITICAL: service_role & BQ key ter-commit/bocor" | **FALSE ALARM** | `git ls-files \| grep .env` → kosong; `git log --all -- .env.local` & `-- .env` → kosong (tak pernah masuk git). `.gitignore` cover `.env`, `.env.local`, `.env.*.local`. Secret hanya di file lokal dev (wajar). Tidak ada paparan repo. *(Subagen mencetak nilai key penuh di laporannya — tidak diulang di sini. Bila `.env.local` pernah dibagikan manual di luar git, rotasi tetap bijak.)* |
| "CRITICAL: .dockerignore → copy .env/.git/node_modules" | **Over-rated → LOW (L1)** | Dockerfile pakai `COPY route_engine/` + `COPY api.py`, bukan `COPY . .`. |
| "CRITICAL: dict.items()/qc_flags non-deterministik" | **Over-rated → LOW** | Insertion-order deterministik di Python 3.7+; seluruh acceptance test lulus byte-per-byte. Layak dirapikan, bukan Critical. |

---

## Backlog terprioritas (checklist)

**Sebelum produksi (blocking):**
- [ ] C1 — guard otorisasi area/depot sebelum `engine.run()`
- [ ] H1 — validasi `ROUTE_ENGINE_SECRET` di endpoint engine
- [ ] H2 — CORS production-safe (matikan regex localhost di prod)
- [ ] M2 — batasi input (`max_items`, bound lat/lon)

**Konsistensi filosofi (penyimpangan senyap — selaras kerja sesi ini):**
- [ ] M4 — `python-dotenv` deklarasi eksplisit + fail jelas
- [ ] M5 — `ROUTE_LENGTH` tolak eksplisit (jangan diam-diam jadi COUNT)

**Verifikasi yang tertunda:**
- [ ] M1 — buktikan RLS/policy & otorisasi RPC SECURITY DEFINER via security advisor DB

**Determinisme & deployment:**
- [ ] M3 — pin `requirements-api.txt` ke `==`
- [ ] L1–L4 — `.dockerignore`, `HEALTHCHECK`, exception handler global, `.env.example`

**Kebersihan:**
- [ ] M6 — model lock TRAFFIC vs BLOCKING + `# TODO confirm` §12
- [ ] M7/M8 — error-handling & race condition frontend
- [ ] L5/L6 — Edge Function redundan, perapian TS

---

## Catatan metodologi

- **Terverifikasi langsung** (tool, bukan sekadar relay subagen): C1, H1, H2, status git semua `.env*`, ketiadaan `.dockerignore`/`.env.example`.
- **Relay dari subagen, belum diverifikasi ulang baris-demi-baris:** sebagian temuan frontend (M7/M8/L6) dan engine (M6) — akurat secara pola, nomor baris bisa bergeser.
- **Tak bisa diverifikasi dari repo:** M1 (definisi RPC/RLS ada di DB Supabase, bukan di kode).
