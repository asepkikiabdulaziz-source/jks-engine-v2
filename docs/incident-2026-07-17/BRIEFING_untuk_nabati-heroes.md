# BRIEFING LINTAS-PROJECT → tim nabati-heroes

**Dari:** sesi JKS Route Engine (`D:\PROJECT\jks-v2`, schema `jks_engine` — penumpang DB `zxrurtmjpaifzjrqcayb`)
**Untuk:** kontributor/pemilik DB nabati-heroes (`D:\PROJECT\nabati-heroes`)
**Sifat:** informasi + permintaan aksi. Bukan permintaan izin, bukan komplain. Arahan sama (Pak Asep).

---

## 1. TL;DR

Login JKS (`admin@jks.pma`) **mati total** — GoTrue menolak menerbitkan token sama sekali, bukan degradasi. Penyebabnya satu baris data di **schema kalian**: `mst_hr.dim_slots` slot `R00-00-02` punya `scope = NULL`, dan `custom_access_token_hook` (`supabase/migrations/0302_login_app_role_self_heal_and_diagnostics.sql:91`) memasukkan nilai itu ke `jsonb_set()` **tanpa `COALESCE`** → `jsonb_set` STRICT → seluruh claims jadi NULL → hook return NULL → token tak terbit. Kami usulkan **migrasi 0393**: `update mst_hr.dim_slots set scope='00' where slot_code='R00-00-02'` — satu baris, idempoten, menyamakan slot ini dengan cetakan sehat `R00-00-03`. Yang kami minta: (a) owner eksekusi 0393 via SQL Editor, (b) **patch hook-nya juga** — ini bug kalian yang masih terpasang dan bisa menjatuhkan user Heroes mana pun, (c) satu kalimat pagar di `CONTRIBUTING.md` supaya kejadian ini tak berulang.

---

## 2. Apa yang rusak & kenapa

`0302_login_app_role_self_heal_and_diagnostics.sql:87-92` — rantai 5 `jsonb_set`:

```
88: jsonb_set(v_claims, '{nik}',       to_jsonb(v_nik))       -- dijaga guard 80-82
89: jsonb_set(v_claims, '{app_role}',  to_jsonb(v_app_role))  -- aman: app_role_for() punya ELSE 'salesman' (0302:36)
90: jsonb_set(v_claims, '{slot_code}', to_jsonb(v_slot_code)) -- aman: PK dim_slots (0064:5) → NOT NULL
91: jsonb_set(v_claims, '{scope}',     to_jsonb(v_scope))     -- ❌ TANPA COALESCE, DAN nullable
92: jsonb_set(v_claims, '{scope_id}',  COALESCE(to_jsonb(v_scope_id), 'null'::jsonb))  -- ✅ di-COALESCE
```

Audit nullability tiap sumber (via `mst_hr.slot_assignment_flat`, `0175:5-48`):

| var | sumber | bisa NULL? | dijaga? |
|---|---|---|---|
| `v_nik` | `a.nik` | ya | guard `0302:80-82` |
| `v_app_role` | `app_role_for()` | tidak (`0302:36` ada `ELSE`) | — |
| `v_slot_code` | `s.slot_code` (PK, `0064:5`) | tidak | — |
| **`v_scope`** | `s.scope` (`0064:10` — `text references mst_hr.scopes(id)`, **nullable, tanpa NOT NULL, tanpa DEFAULT**) | **ya** | **TIDAK** |
| `v_scope_id` | `s.scope_id` (`0064:11`) | ya | ✅ `0302:92` |

**Poin penting, tanpa menyalahkan siapa pun:** penulis 0302 **sudah tahu** `jsonb_set` itu STRICT — buktinya `COALESCE` ada persis di baris berikutnya (92). Yang meleset cuma tebakan *kolom mana* yang bisa NULL. Masuk akal: `scope_id` NULL itu **normal-by-design** (`R00-00-01` di `0065:5` juga `scope_id` NULL) sehingga ketahuan saat uji; `scope` NULL langka, jadi luput.

**Kenapa senyap:** `0302:91` → `v_claims = NULL` → `0302:106` `jsonb_set(event,'{claims}', NULL)` → NULL. Jaring `EXCEPTION WHEN OTHERS THEN RETURN event` **tidak menangkap ini** — NULL bukan exception. Eksekusi lanjut normal, tak ada log, tak ada error. Ini alasan struktural bug bertahan ±2 bulan.

**Ini memukul dua-duanya.** Token tak terbit sama sekali — bukan cuma JKS. User Heroes mana pun yang menempati slot ber-scope NULL akan mati dengan cara identik.

---

## 3. Yang kami usulkan diubah di `mst_hr.dim_slots` kalian

**Migrasi 0393** — satu baris, idempoten:

```sql
update mst_hr.dim_slots set scope = '00' where slot_code = 'R00-00-02';
```

Kenapa aman, semua terverifikasi:

1. **`R00-00-02` adalah SATU-SATUNYA baris `dim_slots` ber-scope NULL di prod.** Probe 40 user: 39 OK, 1 NULL. Blast radius = 1 baris.
2. **Mengikuti cetakan kalian sendiri.** Slot sibling setipe (`job_title` `000002` = ADMIN): `R00-00-01` di `0065_mst_hr_dim_slots_mgmt.sql:6` → `('R00-00-01',NULL,NULL,'000002',NULL,'00',NULL,'00')` — `scope='00'`. `R00-00-03` (febe_priska, ADMIN) di prod juga `scope='00'` (HEAD OFFICE) dan hook-nya SUKSES. `'00'` bukan tebakan kami — itu nilai yang sudah kalian pakai untuk peran yang sama.
3. **Ini mengembalikan invarian yang KALIAN tetapkan.** `app/(admin)/admin/kelola/actions.ts:248` — `if (!scope) return { ok:false, error:"Scope wajib." }`. Aplikasi kalian sendiri menyatakan scope NULL ilegal. `R00-00-02` melanggarnya karena **lahir di luar aplikasi** (insert manual Table Editor — pola yang kalian akui sendiri di `0381_viewer_rolls500_role.sql:15-17`), jadi tak pernah lewat validasi itu.
4. **Harus lewat SQL, tak ada jalan lain.** Panel Kelola (satu-satunya konsol slot) hanya punya 4 aksi tulis: `createSlot` (`actions.ts:280`, INSERT saja), `changeSlotDivision` (`:323`), `archiveSlot` (`:351`), `unarchiveSlot` (`:370`). **Tak ada satu pun yang UPDATE kolom `scope`.** Jadi UI kalian tak bisa merusaknya — tapi juga tak bisa memperbaikinya. Fix wajib migrasi + eksekusi owner via SQL Editor, sesuai `CONTRIBUTING.md`.
5. **CI kalian tak akan protes maupun terpicu.** `.github/workflows/db-integrity.yml:38-40` job `db-drift` jalankan `supabase db diff --linked --schema public,warehouse,heroes2,mst_hr,...` → `db diff` bandingkan **skema, bukan isi baris**. Kalian sudah tulis itu sendiri di `0065:399`: *"db diff compares schema, not these row values"*.

**Sekalian minta:** catat baris `R00-00-02` di migrasi (pola `0381` yang menormalisasi insert manual Table Editor) + komentar eksplisit `-- slot login proyek JKS — jangan hapus/ubah`. Saat ini grep case-insensitive `R00-00-02|99999998|jks\.pma` di seluruh repo kalian = **NOL hasil**. Slot ini permanen tak terlabeli di sisi kalian.

---

## 4. Ini bug KALIAN juga — dan masih terpasang

0393 menutup tiket hari ini. Mekanismenya utuh untuk korban berikutnya.

### Calon korban berikutnya

`0065_mst_hr_dim_slots_mgmt.sql:396-408` — 9 baris placeholder, semua kolom NULL termasuk `scope`:

```
400:  ('1000527',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
...
407:  ('R14.03-07',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
408:  ('R15.03-04',NULL,NULL,NULL,NULL,NULL,NULL,NULL)
```

`R14.03-07` dan `R15.03-04` **bukan baris mati** — keduanya parent slot SBH yang menaungi salesman aktif (`0134_mst_hr_mar_new_slots.sql:45-47` dan `:51-52`). Slot SBH berujung ditempati manusia.

**Batas yang jujur:** probe prod menemukan `R00-00-02` satu-satunya scope-NULL, jadi kesembilan baris ini **sudah direkonsiliasi di prod — ini BUKAN bom aktif.** Yang terbukti dari isi file tetap serius: **git dan prod berbeda persis pada kolom yang menentukan hidup-matinya login**, dan komentar `0065:396-399` menyatakan perbedaan itu disengaja. Konsekuensinya: **replay bersih** (shadow DB, staging baru, DR restore, env lokal) menghasilkan 9 slot scope-NULL termasuk 2 parent SBH bermuatan → login mati di environment itu, dengan gejala yang tak bisa didiagnosa (lihat bawah). Prinsip *"migrasi = catatan replay-able"* di `CONTRIBUTING.md` bocor tepat di kolom paling berbahaya.

### Alat diagnosa kalian tidak akan menolong — ia akan menyesatkan

**`diagnose_login()` (`0302:224-258`) tak pernah menyentuh `scope`.** `SELECT` di `0302:224-226` mengambil `saf.role_name, slot_code, kd_dist, sales_code, region_name, area_name, employee_email` — **`saf.scope_type` tak ada dalam daftar**, padahal view menyediakannya (`0175:14`). Fungsi diagnosa untuk hook yang mati gara-gara scope tidak pernah membaca scope.

Simulasi `admin@jks.pma` menembus tangga sebab-akibat `0302:239-258`:

| cek | hasil | lolos? |
|---|---|---|
| email NULL (`:239`) | terisi | lolos |
| slot NULL (`:241`) | `role_name='ADMIN'` (`0063:64`) | lolos |
| akun NULL (`:243`) | ada | lolos |
| password NULL (`:245`) | true | lolos |
| `NOT role_cached` (`:247`) | **TRUE** — lihat bawah | lolos |
| → `ELSE` (`:249-251`) | **`can_login=true`, `'Siap login.'`** | ❌ |

Blok `checks` (`0302:265-277`) memperparah: `expected_app_role` (`:270`), `app_role_cached` (`:273`), `has_password` (`:272`) — **semua hijau**. Tak satu pun field menyinggung scope. Admin yang men-debug tiket "tidak bisa login" menatap JSON yang menyatakan orang ini 100% sehat.

**Kenapa `role_cached` = TRUE padahal login mati — bagian paling jahat.** Urutan di dalam hook:

```
88-92 : v_claims → NULL di baris 91
96-104: blok UPDATE cache TETAP JALAN (NULL bukan exception)
  97-101:  UPDATE auth.users SET raw_app_meta_data = COALESCE(raw_app_meta_data,'{}') || jsonb_build_object('app_role', v_app_role)
           → v_app_role='admin' → SUKSES, ter-COMMIT
106   : RETURN jsonb_set(event,'{claims}',NULL) → NULL → token ditolak
```

**Setiap percobaan login yang GAGAL justru menulis bukti bahwa user itu sehat.** Makin sering korban mencoba, makin kuat kesan sehat di data. Efek berantai: `0302:233` `role_cached`→TRUE → `0302:247` lolos; `0302:314` `app_role_cached`→TRUE → `0302:335` tersaring keluar. `repair_app_role` (`0302:124-161`) melaporkan `'set: admin'` dengan riang — ia cuma sentuh cache, tak pernah scope. **Operator menarik lever perbaikan, dapat konfirmasi sukses, login tetap mati.**

Perhatikan ironinya: `0302:98-99` pakai `COALESCE(...) || jsonb_build_object(...)` — **konstruksi merge yang BENAR dan null-safe**, enam baris di bawah rantai `jsonb_set` yang membunuh login. Pola penyelamatnya sudah ada di file yang sama.

**`list_login_problems()` (`0302:320-347`) juga miss.** CTE `problems_slot` deteksi 3 problem_code (`:323-327`) lalu saring `:335`: `WHERE email IS NULL OR NOT has_auth_user OR NOT COALESCE(app_role_cached,false)` — **ketiganya FALSE untuk korban scope-NULL** → hilang dari hasil. CTE `orphan` (`:338-347`) syaratnya `NOT EXISTS (...active_slot...)` — korban justru **punya** slot aktif. Sumber `active_slot` (`:298-304`) SELECT `assignment_nik, role_name, employee_email` — `scope_type` absen lagi. Hasil: panel `app/(admin)/admin/login-health/` menampilkan **daftar kosong** untuk kelas bug paling fatal yang sistem punya. Severity `'high'` di fungsi ini dicadangkan untuk `unknown_role` — masalah yang **masih mengizinkan token terbit**. Kegagalan yang jauh lebih parah tak punya problem_code sama sekali.

### Gate assignment tak melawan

`0211_assignment_ops_golden_rule.sql:53`, `0211:175`, `0219_assign_slot_primitive.sql:35` — ketiganya identik: `IF NOT EXISTS (SELECT 1 FROM mst_hr.dim_slots WHERE slot_code = p_slot_code)`. Cek **eksistensi baris**, nol pemeriksaan **isi**. FK `scope text references mst_hr.scopes(id)` (`0064:10`) juga tak menolak NULL — FK hanya validasi nilai non-NULL. Menugaskan manusia ke slot yang akan mematikan login-nya **sukses di setiap lapisan**: konsol terima, RPC luluskan, FK setuju, nol WARNING. Kegagalan muncul di tempat lain (GoTrue), waktu lain (login berikutnya), tanpa jejak penghubung.

### Tak ada satu pun test yang mengeksekusi hook

- **Unit test:** grep `custom_access_token_hook --include=*.ts` → satu-satunya file test adalah `lib/__tests__/login-health-actions.test.ts`, menguji server action dengan Supabase **ter-mock** — tak pernah jalankan SQL, mustahil amati `jsonb_set` STRICT. **Nol test SQL.**
- **db-drift** (`db-integrity.yml:40-41`): bandingkan DDL. `scope=NULL` adalah nilai baris. Buta by design — dan kalian sudah tahu (`0065:399`).
- **migration-dups** (`db-integrity.yml:11-19`): cek nomor duplikat. Tak relevan.
- **test.yml** `quality`/`build`: TypeScript. Hook adalah PL/pgSQL.
- **e2e:** `test.yml:78` → `if: ${{ vars.RUN_E2E == 'true' }}` — **mati kecuali di-set eksplisit**. Andai nyala, `e2e/auth.spec.ts:26-31` `loginAs(page,"admin")` pakai akun test tetap yang scope-nya sehat.

Lima lapisan, nol yang menyentuh jalur ini. CI TypeScript berhenti di tepi database; CI database berhenti di tepi DDL; nilai baris yang menentukan hidup-matinya autentikasi jatuh persis di celah itu.

### Patch hook usulan — null-safe, mengganti HANYA `0302:86-106`

Guard email (`68-70`), guard nik (`80-82`), `app_role_for` (`84`), blok cache (`96-104`), GRANT/REVOKE (`115-116`) tak disentuh.

```sql
-- jsonb_build_object TIDAK strict: argumen NULL → nilai JSON `null`, bukan SQL NULL.
-- Memulihkan invariant yang hilang di 0193:69-71 (dulu dijaga `IF v_slot_code IS NOT NULL`,
-- dibuang saat refactor ke slot_assignment_flat).
v_claims := COALESCE(event->'claims', '{}'::jsonb)
         || jsonb_build_object(
              'nik',       v_nik,
              'app_role',  v_app_role,
              'slot_code', v_slot_code,
              'scope',     v_scope,      -- NULL → JSON null, tak lagi meracuni hasil
              'scope_id',  v_scope_id
            );

... blok UPDATE cache 96-104 tetap apa adanya ...

v_out := jsonb_set(event, '{claims}', v_claims);

-- Sabuk pengaman: NULL bukan exception, handler baris 108 tak akan menangkapnya.
-- Lebih baik token tanpa claim (degradasi → unknown_role, terdiagnosa)
-- daripada token tak terbit sama sekali (login mati total, tak terdiagnosa).
IF v_out IS NULL THEN
  RAISE WARNING 'custom_access_token_hook: claims NULL utk user % (slot %, scope %) — kembalikan event apa adanya',
                v_user_id, v_slot_code, v_scope;
  RETURN event;
END IF;
RETURN v_out;
```
Tambah `v_out jsonb;` ke DECLARE (`0302:54-63`).

**Kenapa aman — tiga alasan yang bisa dicek dari file itu sendiri:**
1. **Bentuk JWT tidak berubah untuk 39 user sehat.** `jsonb_build_object('scope_id', NULL)` → `"scope_id": null` — **identik** dengan output `0302:92` hari ini. Untuk user ber-scope terisi, semua claim sama persis. Perubahan perilaku **hanya** pada kasus yang saat ini mati total.
2. **`||` pada dua jsonb = merge shallow**, semantik sama dengan `jsonb_set` berturut pada key top-level — dan penulis 0302 **sudah memercayainya untuk data auth** di `0302:98-99`.
3. **`COALESCE(event->'claims','{}')` menutup kasus tepi tambahan:** bila GoTrue kirim event tanpa `'claims'`, kode saat ini (`0302:87`) menghasilkan NULL diam-diam. Tak ada perlindungan itu sekarang.

**Batas patch — apa yang TIDAK diperbaikinya:** `R00-00-02` tetap dapat `"scope": null` di JWT-nya. Login hidup, tapi otorisasi berbasis scope di sisi konsumen bisa aneh. **0393 tetap WAJIB.** Patch hook mengubah kegagalan-total jadi kegagalan-yang-kelihatan; ia bukan pengganti data yang benar.

---

## 5. Gap batas — kenapa ini jebol

Ini bagian yang paling ingin kami sampaikan, karena berlaku dua arah dan akan terulang tanpa perubahan dokumen.

**Pagar kalian melindungi SCHEMA, bukan IDENTITAS.** Grep `jks` di seluruh `*.md` repo kalian = **6 baris**: `CETAK_BIRU_REFACTOR_DB.md:32,96,97,105,136` · `KONTEKS_PROYEK.md:36` · `DOKUMENTASI_TEKNIS.md:178`. Semua bicara `jks_engine.*` — permukaan schema:
- `KONTEKS_PROYEK.md:36` — *"⚠️ `jks_engine` = proyek LAIN"*
- `0169_jks_engine_shim_for_replay.sql:5` — *"jks_engine adalah schema PROYEK LAIN yang kebetulan berbagi database ini"*
- `CETAK_BIRU_REFACTOR_DB.md:32` — *"Milik proyek lain (JANGAN sentuh): jks_engine.plans/plan_assignments/access_roles/stores_staging"*

Grep silang `jks` × (auth|dim_slots|login|slot|token|hook) → **HANYA 1 baris**: `CETAK_BIRU_REFACTOR_DB.md:96` — *"berbagi DB ini untuk auth yang sama"*. Satu anak-kalimat sisipan, **tanpa menyebut tabel apa pun**.

Grep `dim_slots` di `CONTRIBUTING.md` / `AUDIT_ARSITEKTUR.md` / `CETAK_BIRU_REFACTOR_DB.md` / `DOKUMENTASI_TEKNIS.md` = **0 hit di keempatnya**. `CLAUDE.md` & `AGENTS.md`: grep `jks` = **0 hit**.

Sebaliknya `CONTRIBUTING.md:101` menulis aturan hook **tanpa satu pun kata tentang konsumen lain**: *"Sumber role TUNGGAL = `mst_hr` → JWT. `app_role` (+`nik`/`slot_code`) di-inject `custom_access_token_hook` dari `mst_hr` … Jangan set/ubah `app_role` manual"*. `KONTEKS_PROYEK.md:66-67` idem.

**Konsekuensinya persis jalur insiden ini:** `mst_hr.dim_slots` dan `auth.users` diperlakukan 100% aset internal Heroes — di dalam daftar yang kalian kelola dan audit. Tak ada satu kalimat pun yang memberi tahu penyunting bahwa satu baris di sana bisa mematikan login proyek lain. Perubahan yang **sah** di sisi kalian bisa lolos semua review tanpa pernah memicu pertanyaan "apakah ini merusak JKS".

Dan asimetrinya nyata: baris login JKS hidup di **schema milik kalian, tanpa penanda apa pun**. Siapa pun yang membersihkan "slot aneh tanpa scope, tanpa jejak migrasi" akan wajar menganggapnya sampah. Itu juga menjelaskan asal cacatnya — `R00-00-02` tak pernah lewat migrasi, jadi tak pernah lewat pola seed yang benar (`scope='00'` seperti `R00-00-01` di `0065:6`).

**Usul kalimat konkret** — tambahkan di `CONTRIBUTING.md` tepat setelah baris 101 (blok "Sumber role TUNGGAL"):

> ⚠️ **`mst_hr.dim_slots`, `auth.users`, dan `custom_access_token_hook` = permukaan BERSAMA dengan proyek JKS (`jks_engine`), bukan aset internal kita.** Hook ini menerbitkan token untuk SEMUA user di DB ini, termasuk user JKS (mis. `admin@jks.pma`, slot `R00-00-02`). Baris `dim_slots` yang cacat (mis. `scope` NULL) membuat hook mengembalikan NULL → GoTrue menolak menerbitkan token → **login proyek lain mati total**, tanpa exception dan tanpa log. Setiap insert/update `dim_slots` WAJIB mengisi `scope` (non-NULL) dan setiap perubahan hook WAJIB `COALESCE` pada semua argumen `jsonb_set`.

Cermin kalimat yang sama di `KONTEKS_PROYEK.md:66-67`.

---

## 6. Yang kami minta

| # | Siapa | Aksi | Urgensi |
|---|---|---|---|
| **1** | Owner DB (Pak Asep) | Eksekusi **migrasi 0393** via SQL Editor: `update mst_hr.dim_slots set scope='00' where slot_code='R00-00-02';` → login JKS hidup kembali. 1 baris, idempoten, blast radius terverifikasi = 1. | **SEGERA** |
| **2** | Kontributor nabati-heroes | Commit 0393 ke `supabase/migrations/` sebagai catatan replay-able, + catat baris `R00-00-02` (pola `0381`) dengan komentar `-- slot login proyek JKS — jangan hapus/ubah`. Saat ini grep `R00-00-02` di repo kalian = 0 hit. | Segera |
| **3** | Kontributor nabati-heroes | **Migrasi 0394 — patch hook null-safe** (§4). Menghapus seluruh kelas bug, bukan menambal satu kolom. Menguntungkan kalian: user Heroes ber-slot cacat akan degradasi ke `unknown_role` (terdiagnosa) alih-alih mati total (tak terdiagnosa). | Tinggi |
| **4** | Kontributor nabati-heroes | `diagnose_login()`: tambah `saf.scope_type` ke SELECT `0302:224`, tambah cabang **SEBELUM** `0302:247` (lebih fatal): `ELSIF v_slot.scope_type IS NULL THEN v_reason := 'Slot '||v_slot.slot_code||' tak punya scope → hook return NULL → GoTrue tolak token. Login MATI TOTAL. Isi scope di konsol Kelola.'`. Tambah `'scope', v_slot.scope_type` ke blok `checks` `0302:265-277`. | Tinggi |
| **5** | Kontributor nabati-heroes | `list_login_problems()`: tarik `saf.scope_type` ke CTE `active_slot` (`0302:298-304`), tambah problem_code `'slot_scope_null'`, masukkan `scope_type IS NULL` ke WHERE `0302:335`. Pertimbangkan severity di ATAS `'high'` (mis. `'fatal'`) — `ORDER BY` `0302:354` kini menyetarakan kegagalan-total dengan kegagalan-parsial. | Sedang |
| **6** | Kontributor nabati-heroes | **Assert nilai (bukan struktur)** di CI atau monitor terjadwal — satu-satunya lapisan yang akan berteriak saat slot scope-NULL berikutnya dibuat lewat konsol: <br>`SELECT s.slot_code, p.name AS role_name, e.full_name, e.email FROM mst_hr.dim_slots s LEFT JOIN mst_hr.positions p ON p.id=s.job_title LEFT JOIN mst_hr.assignments a ON a.slot_code=s.slot_code AND a.end_date IS NULL LEFT JOIN mst_hr.employees e ON e.nik=a.nik WHERE s.scope IS NULL;` <br>Nol baris = sehat. Hari ini akan mengembalikan `R00-00-02`. | Sedang |
| **7** | Owner DB | Kueri prod untuk nilai `scope` **sebenarnya** dari 9 placeholder `0065:400-408` (**jangan tebak**), tulis migrasi yang menggantikan placeholder NULL → replay bersih menghasilkan DB yang login-nya hidup. Menutup satu-satunya alasan komentar `0065:396-399` harus ada. | Sedang |
| **8** | Kontributor nabati-heroes | Rapatkan gate: `0211:53`, `0211:175`, `0219:35` tambah `AND scope IS NOT NULL` + pesan error eksplisit. ⚠️ **Urutkan setelah #7** — placeholder `0065:400-408` sengaja scope-NULL di git, constraint ini akan menggagalkan replay sampai #7 beres. | Rendah |
| **9** | Kontributor nabati-heroes | Tambah kalimat pagar di `CONTRIBUTING.md` (setelah baris 101) + cermin di `KONTEKS_PROYEK.md:66-67` — teks lengkap di §5. | Sedang |
| **10** | Sesi JKS (kami) | Pasang health-check dari sisi kami yang memverifikasi hook mengembalikan claim non-NULL. Kami tidak akan berharap CI kalian jadi jaring pengaman — `db diff` memang tak melihat nilai baris, dan itu wajar. | Kami |

---

### Catatan batas wewenang

Seluruh usul di atas menyentuh `nabati-heroes`. `KONTEKS_PROYEK.md:36` kalian menegaskan *"jks_engine = proyek LAIN yang menumpang DB ini — JANGAN sentuh"* — **batas itu berlaku dua arah, dan kami hormati.** Tak ada satu pun perubahan di dokumen ini yang kami terapkan atau akan terapkan dari sisi JKS. Ini temuan + usul; penerapan ke prod adalah hak kalian via SQL Editor sesuai `CONTRIBUTING.md`.

Satu penutup: kami tidak minta perlakuan istimewa. `app/(admin)/admin/kelola/actions.ts:248` — *"Scope wajib."* — itu **aturan kalian**. `R00-00-02` melanggarnya karena lahir di luar aplikasi kalian. 0393 hanya mengembalikan slot itu ke invarian yang kalian tetapkan sendiri.