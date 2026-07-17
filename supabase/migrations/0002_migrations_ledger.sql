-- 0002_migrations_ledger.sql — ledger migrasi JKS (mengikuti pola nabati-heroes).
-- Setelah ini, setiap perubahan skema di jks_engine/public (bagian JKS) HARUS lewat file
-- bernomor di sini + tercatat di tabel ini — bukan lahir manual lagi via Table Editor.

create table if not exists jks_engine._migrations (
  filename    text primary key,
  applied_at  timestamptz not null default now()
);

-- Tandai 0001 & 0002 sebagai sudah diterapkan (sudah ada di DB sebelum runner ini dibuat).
insert into jks_engine._migrations (filename) values
  ('0001_baseline.sql'),
  ('0002_migrations_ledger.sql')
on conflict (filename) do nothing;
