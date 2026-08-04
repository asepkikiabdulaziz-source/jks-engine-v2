"""
tests/test_rpc_authz.py — Regresi otorisasi RPC (C1, migrasi 0003/0004).

Lahir dari insiden 2026-07-17 (lihat docs/incident-2026-07-17/): guard `auth.uid()`
diterapkan ke 6 RPC, lalu KETAHUAN merusak `/generate-plan` beberapa menit kemudian
(save_plan dipanggil api.py lewat service_role, JWT tanpa klaim `sub` -> auth.uid()
NULL -> guard salah menolak). Waktu itu regresi hanya ketahuan karena verifikasi
manual segera sesudahnya — tak ada yang mencegahnya terjadi lagi di masa depan.

Uji langsung ke DB LIVE via SUPABASE_DB_URL (bukan mock) — satu-satunya cara
menguji perilaku SECURITY DEFINER + auth.uid() yang sesungguhnya bergantung pada
konteks sesi Postgres, bukan sesuatu yang bisa disimulasikan lewat mock Python.
SETIAP test dibungkus transaksi yang SELALU di-rollback (fixture db_cursor) --
tidak pernah menulis/mengubah data prod, persis pola verifikasi manual sepanjang
insiden 07-17.

Skip otomatis kalau SUPABASE_DB_URL tak tersedia (mis. CI tanpa akses DB).
"""
import uuid
from pathlib import Path

import psycopg2
import pytest

ROOT = Path(__file__).parent.parent


def _load_db_url():
    env_file = ROOT / ".env.local"
    if not env_file.exists():
        return None
    for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("SUPABASE_DB_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


DB_URL = _load_db_url()

# admin@jks.pma -- EXTERNAL_JKS (000004), aktif di jks_engine.access_roles. Akun uji
# tetap milik JKS sendiri; lihat docs/incident-2026-07-17/README.md.
JKS_ADMIN_ID = "6ac912c3-7f87-4bcf-81f3-a1fe4e02b7c1"

ACCESS_DENIED = "Akses ditolak: user tidak berwenang di JKS"

pytestmark = pytest.mark.skipif(
    DB_URL is None,
    reason="SUPABASE_DB_URL tidak ada di .env.local -- test integrasi ini butuh akses DB live",
)


@pytest.fixture
def db_cursor():
    """Cursor dalam transaksi yang SELALU di-rollback -- nol jejak di prod."""
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    cur = conn.cursor()
    try:
        yield cur
    finally:
        conn.rollback()
        conn.close()


def _as_member(cur, user_id: str = JKS_ADMIN_ID):
    """Simulasikan auth.uid() = user_id, seperti PostgREST utk request browser+sesi."""
    cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (user_id,))


def _as_anonymous_session(cur):
    """Simulasikan auth.uid() = NULL, seperti panggilan via service_role (api.py:_db()).

    JWT service_role tak punya klaim `sub` -- ini persis penyebab regresi 07-17.
    """
    cur.execute("select set_config('request.jwt.claim.sub', '', true)")


def _random_uuid() -> str:
    """User yang dijamin BUKAN member JKS (tak ada di jks_engine.access_roles)."""
    return str(uuid.uuid4())


def _denied(exc: psycopg2.Error) -> bool:
    msg = str(exc)
    return ACCESS_DENIED in msg and "42501" in (exc.pgcode or "") or ACCESS_DENIED in msg


# ---------------------------------------------------------------------------
# get_my_profile -- filter WHERE auth.uid() (bukan RAISE EXCEPTION; baris kosong = ditolak)
# ---------------------------------------------------------------------------

def test_get_my_profile_returns_own_profile_for_member(db_cursor):
    _as_member(db_cursor, JKS_ADMIN_ID)
    db_cursor.execute("select * from get_my_profile(%s::uuid)", (JKS_ADMIN_ID,))
    rows = db_cursor.fetchall()
    assert len(rows) == 1, "admin@jks.pma harus dapat 1 baris profil"


def test_get_my_profile_ignores_client_supplied_p_user_id(db_cursor):
    """p_user_id dari parameter TIDAK boleh dipakai -- hanya auth.uid() yang menentukan.

    Regresi yang dicegah: kalau seseorang mengembalikan filter ke p_user_id (seperti
    sebelum fix ini), pemanggil bisa membaca profil ORANG LAIN cukup dengan mengganti
    parameter, walau auth.uid()-nya sendiri.
    """
    _as_member(db_cursor, JKS_ADMIN_ID)
    spoofed_id = _random_uuid()
    db_cursor.execute("select nik from get_my_profile(%s::uuid)", (spoofed_id,))
    rows = db_cursor.fetchall()
    assert len(rows) == 1, "auth.uid() harus tetap menentukan hasil, terlepas dari p_user_id"
    assert rows[0][0] == "99999998", "harus tetap profil ADMIN JKS (nik 99999998), bukan kosong/orang lain"


def test_get_my_profile_empty_for_non_member(db_cursor):
    _as_member(db_cursor, _random_uuid())
    db_cursor.execute("select * from get_my_profile(%s::uuid)", (JKS_ADMIN_ID,))
    assert db_cursor.fetchall() == []


# ---------------------------------------------------------------------------
# 4 RPC mutasi dgn pola guard identik (RAISE EXCEPTION di awal fungsi)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("sql,params", [
    ("select discard_plan(%s::uuid)", (str(uuid.uuid4()),)),
    ("select approve_plan(%s::uuid, %s::uuid)", (str(uuid.uuid4()), JKS_ADMIN_ID)),
    ("select stage_stores(%s::uuid, '[]'::jsonb)", (str(uuid.uuid4()),)),
    ("select upsert_stores(%s::uuid, '[]'::jsonb)", (str(uuid.uuid4()),)),
], ids=["discard_plan", "approve_plan", "stage_stores", "upsert_stores"])
def test_mutating_rpc_rejects_non_member(db_cursor, sql, params):
    _as_member(db_cursor, _random_uuid())
    with pytest.raises(psycopg2.Error) as exc_info:
        db_cursor.execute(sql, params)
    assert _denied(exc_info.value), f"non-member harus ditolak guard, dapat: {exc_info.value}"


@pytest.mark.parametrize("sql,params", [
    ("select discard_plan(%s::uuid)", (str(uuid.uuid4()),)),
    ("select approve_plan(%s::uuid, %s::uuid)", (str(uuid.uuid4()), JKS_ADMIN_ID)),
    ("select stage_stores(%s::uuid, '[]'::jsonb)", (str(uuid.uuid4()),)),
], ids=["discard_plan", "approve_plan", "stage_stores"])
def test_mutating_rpc_passes_guard_for_member(db_cursor, sql, params):
    """Member LOLOS guard -- boleh gagal di logika bisnis lain (plan tak ada, dst),
    TAPI TIDAK BOLEH gagal dengan pesan 'Akses ditolak'."""
    _as_member(db_cursor, JKS_ADMIN_ID)
    try:
        db_cursor.execute(sql, params)
    except psycopg2.Error as e:
        assert not _denied(e), f"member SEHARUSNYA lolos guard, malah ditolak: {e}"


def test_upsert_stores_passes_guard_for_member_area_not_found_after(db_cursor):
    """upsert_stores cek keanggotaan DULU, baru cek area_id ada -- urutan ini penting
    (guard tak boleh menunggu validasi lain)."""
    _as_member(db_cursor, JKS_ADMIN_ID)
    with pytest.raises(psycopg2.Error) as exc_info:
        db_cursor.execute("select upsert_stores(%s::uuid, '[]'::jsonb)", (str(uuid.uuid4()),))
    msg = str(exc_info.value)
    assert not _denied(exc_info.value), f"member ditolak guard, seharusnya lolos: {msg}"
    assert "not found" in msg, f"harus gagal di validasi area_id, bukan di guard: {msg}"


# ---------------------------------------------------------------------------
# save_plan -- KASUS REGRESI 07-17. COALESCE(auth.uid(), p_created_by).
# ---------------------------------------------------------------------------

def _call_save_plan(cur, created_by: str):
    cur.execute(
        """select save_plan(gen_random_uuid(), gen_random_uuid(), 'pytest-authz-guard',
                             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, %s::uuid, '[]'::jsonb)""",
        (created_by,),
    )


def test_save_plan_browser_context_member_passes(db_cursor):
    """Jalur biasa: auth.uid() terisi (browser+sesi user)."""
    _as_member(db_cursor, JKS_ADMIN_ID)
    _call_save_plan(db_cursor, JKS_ADMIN_ID)  # tak boleh raise -- INSERT sukses (lalu di-rollback)


def test_save_plan_browser_context_non_member_rejected(db_cursor):
    non_member = _random_uuid()
    _as_member(db_cursor, non_member)
    with pytest.raises(psycopg2.Error) as exc_info:
        _call_save_plan(db_cursor, non_member)
    assert _denied(exc_info.value)


def test_save_plan_service_role_context_member_passes(db_cursor):
    """INI test regresi 07-17: auth.uid() NULL (persis panggilan api.py via service_role),
    p_created_by = member -- HARUS lolos. Sebelum fix 0004, ini SALAH DITOLAK."""
    _as_anonymous_session(db_cursor)
    _call_save_plan(db_cursor, JKS_ADMIN_ID)  # tak boleh raise


def test_save_plan_service_role_context_non_member_rejected(db_cursor):
    """C1 tertutup utk jalur ini: user non-JKS yg curl /generate-plan langsung
    (api.py meneruskan user_id mrk sbg p_created_by) tetap ditolak di dalam save_plan,
    walau api.py sendiri panggil lewat service_role."""
    _as_anonymous_session(db_cursor)
    with pytest.raises(psycopg2.Error) as exc_info:
        _call_save_plan(db_cursor, _random_uuid())
    assert _denied(exc_info.value)


# ---------------------------------------------------------------------------
# get_stores_by_area -- C1 jalur BACA. Pemanggil CAMPURAN: 4 tempat di src/
# (browser, auth.uid() terisi) + 3 tempat di api.py (service_role, auth.uid()
# NULL, param baru p_caller_id sbg fallback). Signature: (p_area_id uuid,
# p_caller_id uuid DEFAULT NULL) -- default NULL supaya 4 pemanggil browser
# TAK PERLU diubah sama sekali (PostgREST kirim named-param, yang tak dikirim
# otomatis pakai default).
#
# TANGERANG_KOTA dipakai (bukan UUID acak) supaya test "member lolos" juga
# membuktikan data tetap mengalir benar, bukan cuma "tidak error".
# ---------------------------------------------------------------------------

TANGERANG_KOTA_ID = "57b8e747-91d2-4b0a-89c1-35141d09d72a"


def test_get_stores_by_area_browser_context_member_passes(db_cursor):
    _as_member(db_cursor, JKS_ADMIN_ID)
    db_cursor.execute("select * from get_stores_by_area(%s::uuid)", (TANGERANG_KOTA_ID,))
    rows = db_cursor.fetchall()
    assert len(rows) > 0, "member harus tetap dapat data toko (regresi: guard terlalu ketat)"


def test_get_stores_by_area_browser_context_non_member_rejected(db_cursor):
    """CELAH C1 (sebelum fix): non-member (JWT valid dari GoTrue bersama, tanpa
    entry di access_roles) masih bisa baca customer_code+lat/lon toko AREA MANA
    PUN lewat 4 pemanggil browser di src/ (exportPlan.ts, DashboardPage.tsx,
    PlanMapPage.tsx, RoutingEnginePage.tsx)."""
    _as_member(db_cursor, _random_uuid())
    with pytest.raises(psycopg2.Error) as exc_info:
        db_cursor.execute("select * from get_stores_by_area(%s::uuid)", (TANGERANG_KOTA_ID,))
    assert _denied(exc_info.value)


def test_get_stores_by_area_service_role_context_member_passes(db_cursor):
    """Persis pola /generate-plan,/stage1,/stage2: api.py panggil via service_role
    (auth.uid() NULL), meneruskan user_id terverifikasi sbg p_caller_id."""
    _as_anonymous_session(db_cursor)
    db_cursor.execute(
        "select * from get_stores_by_area(%s::uuid, %s::uuid)", (TANGERANG_KOTA_ID, JKS_ADMIN_ID)
    )
    rows = db_cursor.fetchall()
    assert len(rows) > 0


def test_get_stores_by_area_service_role_context_non_member_rejected(db_cursor):
    """CELAH C1 (sebelum fix): user non-JKS yg curl /stage1,/stage2,/generate-plan
    langsung (bypass browser) -- api.py meneruskan user_id mereka sbg p_caller_id,
    HARUS ditolak di dalam get_stores_by_area, walau api.py panggil via service_role."""
    _as_anonymous_session(db_cursor)
    with pytest.raises(psycopg2.Error) as exc_info:
        db_cursor.execute(
            "select * from get_stores_by_area(%s::uuid, %s::uuid)", (TANGERANG_KOTA_ID, _random_uuid())
        )
    assert _denied(exc_info.value)


# ---------------------------------------------------------------------------
# GRANT/ACL -- lapisan yang TAK SATU PUN test di atas menyentuh, dan justru di
# situlah kebocoran nyata terjadi (migrasi 0006).
#
# Guard di dalam fungsi tak berarti apa-apa kalau fungsinya bisa dijangkau role
# yang auth.uid()-nya NULL: COALESCE(auth.uid(), p_caller_id) lalu jatuh ke
# parameter yang DIKENDALIKAN KLIEN. Terverifikasi bocor 371 baris ke `anon`
# tanpa login sama sekali sebelum 0006.
#
# Kenapa ini WAJIB dijaga test, bukan sekadar diperbaiki sekali: Supabase memasang
# ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
# service_role di schema `public`. Jadi setiap DROP FUNCTION + CREATE berikutnya
# MENGEMBALIKAN EXECUTE ke `anon` secara diam-diam. Persis itu yang terjadi di
# 0005 -- satu-satunya migrasi yang memakai DROP (0003/0004 cuma CREATE OR REPLACE).
# ---------------------------------------------------------------------------

JKS_RPCS = [
    "public.get_stores_by_area(uuid,uuid)",
    "public.get_plans_by_area(uuid)",
    "public.get_plan_assignments(uuid)",
    "public.save_plan(uuid,uuid,text,jsonb,jsonb,jsonb,uuid,jsonb)",
    "public.approve_plan(uuid,uuid)",
    "public.discard_plan(uuid)",
    "public.stage_stores(uuid,jsonb)",
    "public.upsert_stores(uuid,jsonb)",
]


@pytest.mark.parametrize("rpc", JKS_RPCS)
def test_rpc_not_executable_by_anon(db_cursor, rpc):
    """Tak satu pun RPC JKS boleh dijangkau tanpa login.

    `anon` = anon key, yang PUBLIK by design (api.py menyuntikkannya ke browser
    lewat window.__ENV__). EXECUTE untuk anon = fungsi itu terbuka ke internet.
    """
    db_cursor.execute("select has_function_privilege('anon', %s, 'EXECUTE')", (rpc,))
    assert db_cursor.fetchone()[0] is False, (
        f"{rpc} bisa dieksekusi `anon` -- terbuka tanpa login. "
        "Kemungkinan besar ada DROP FUNCTION baru: default privileges Supabase "
        "mengembalikan EXECUTE ke anon. Tambahkan REVOKE (pola migrasi 0006)."
    )


@pytest.mark.parametrize("rpc", JKS_RPCS)
def test_rpc_executable_by_authenticated_and_service_role(db_cursor, rpc):
    """Sisi sebaliknya: REVOKE tak boleh kebablasan.

    authenticated = pemanggil browser di src/; service_role = api.py.
    Kalau salah satu hilang, aplikasi mati -- dan `REVOKE ... FROM public` yang
    dijalankan tanpa GRANT eksplisit lebih dulu adalah cara paling mudah
    membuatnya hilang.
    """
    for role in ("authenticated", "service_role"):
        db_cursor.execute("select has_function_privilege(%s, %s, 'EXECUTE')", (role, rpc))
        assert db_cursor.fetchone()[0] is True, f"{role} kehilangan EXECUTE pada {rpc}"


def test_anon_cannot_read_stores_even_with_valid_member_uuid(db_cursor):
    """Regresi atas kebocoran sesungguhnya (0006) -- jalur eksploitasi apa adanya.

    Sebelum 0006 ini mengembalikan 371 baris: `anon` (tanpa sesi, auth.uid() NULL)
    memasok UUID anggota JKS lewat p_caller_id, COALESCE memakainya, guard lolos.
    UUID itu bukan rahasia -- ada di file ini, baris 42, di repo PUBLIK.

    Beda dari test has_function_privilege di atas: yang ini menjalankan serangannya,
    bukan memeriksa metadata. Keduanya perlu -- ACL bisa benar tapi fungsi diganti,
    atau sebaliknya.
    """
    db_cursor.execute("savepoint anon_probe")
    _as_anonymous_session(db_cursor)
    db_cursor.execute("set local role anon")
    try:
        with pytest.raises(psycopg2.Error) as exc_info:
            db_cursor.execute(
                "select count(*) from public.get_stores_by_area(%s::uuid, %s::uuid)",
                (TANGERANG_KOTA_ID, JKS_ADMIN_ID),
            )
        assert "permission denied" in str(exc_info.value).lower(), (
            "anon harus ditolak di level GRANT, sebelum guard di dalam fungsi sempat jalan"
        )
    finally:
        db_cursor.execute("rollback to savepoint anon_probe")
        db_cursor.execute("reset role")
