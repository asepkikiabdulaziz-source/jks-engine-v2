"""
test_balance_criterion.py — ROUTE_LENGTH harus DITOLAK, bukan diterima diam-diam.

Sebelum perbaikan ini, `balanced_partition` menerima criterion=ROUTE_LENGTH lalu
mengabaikannya sepenuhnya dan memartisi berdasarkan COUNT. Docstring-nya sendiri
mengakuinya: "ROUTE_LENGTH diterima tapi diperlakukan sama."

Ini penyimpangan senyap — anti-pola yang sudah diberantas di tempat lain di engine
ini (fallback algoritma di partition.py, KMeansConstrained yang wajib), tapi masih
hidup di sini. AUDIT.md mencatatnya sebagai M5 dan ia bertahan tiga bulan.

Bahayanya bukan hipotetis: pemanggil memilih "seimbangkan panjang rute", mendapat
partisi jumlah-toko, dan tak ada satu pun sinyal bahwa pilihannya tak berpengaruh.
"""
import pytest

from route_engine.core.partition import balanced_partition
from route_engine.models import BalanceCriterion, PlanConfig, Store


def _stores(n: int):
    return [
        Store(customer_code=f"C{i:04d}", latitude=-6.2 + i * 0.01, longitude=106.8 + i * 0.01)
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Gerbang 1: PlanConfig — batas paling awal
# ---------------------------------------------------------------------------

def test_planconfig_menolak_route_length():
    with pytest.raises(NotImplementedError) as exc:
        PlanConfig(n_sales=3, depo_lat=-6.2, depo_lon=106.8,
                   balance_criterion=BalanceCriterion.ROUTE_LENGTH)
    assert "ROUTE_LENGTH" in str(exc.value)


def test_planconfig_menerima_count():
    cfg = PlanConfig(n_sales=3, depo_lat=-6.2, depo_lon=106.8,
                     balance_criterion=BalanceCriterion.COUNT)
    assert cfg.balance_criterion is BalanceCriterion.COUNT


def test_planconfig_default_tetap_count():
    """Default tak boleh berubah — semua pemanggil mengandalkannya."""
    assert PlanConfig(n_sales=3, depo_lat=-6.2, depo_lon=106.8).balance_criterion \
        is BalanceCriterion.COUNT


# ---------------------------------------------------------------------------
# Gerbang 2: balanced_partition — bisa dipanggil langsung, tanpa PlanConfig
# ---------------------------------------------------------------------------

def test_balanced_partition_menolak_route_length():
    """scheduling.py, api.py, dan pemakai route_engine sebagai paket memanggil
    fungsi ini LANGSUNG — gerbang PlanConfig tidak melindungi jalur itu."""
    with pytest.raises(NotImplementedError) as exc:
        balanced_partition(_stores(30), 3, criterion=BalanceCriterion.ROUTE_LENGTH)
    assert "ROUTE_LENGTH" in str(exc.value)


def test_balanced_partition_count_tetap_jalan():
    labels = balanced_partition(_stores(30), 3, criterion=BalanceCriterion.COUNT)
    assert len(labels) == 30
    assert set(labels.values()) == {0, 1, 2}


def test_ditolak_sebelum_komputasi_apa_pun():
    """Penolakan harus terjadi di depan, bukan setelah K-Means berjalan.

    Dipanggil dengan n=0 toko: kalau gerbangnya di depan, tetap NotImplementedError.
    Kalau gerbangnya di belakang, jalur pintas 'n_total == 0' akan mengembalikan
    dict kosong dengan tenang — dan criterion yang salah lolos tanpa jejak.
    """
    with pytest.raises(NotImplementedError):
        balanced_partition([], 3, criterion=BalanceCriterion.ROUTE_LENGTH)


# ---------------------------------------------------------------------------
# Kenapa ini penting: buktikan perilaku LAMA memang tak bisa dibedakan
# ---------------------------------------------------------------------------

def test_route_length_dulu_menghasilkan_partisi_identik_dengan_count():
    """Merekam kenapa bug ini tak pernah terlihat.

    Perilaku lama mengabaikan criterion sepenuhnya, jadi ROUTE_LENGTH dan COUNT
    menghasilkan partisi yang SAMA PERSIS. Tak ada keluaran yang aneh, tak ada
    error, tak ada yang bisa dicurigai — satu-satunya cara mengetahuinya adalah
    membaca docstring-nya. Itulah sebabnya penyimpangan senyap harus ditolak di
    gerbang, bukan diandalkan ketahuan dari hasilnya.

    Test ini mensimulasikan perilaku lama (memanggil dengan COUNT dua kali) untuk
    menunjukkan partisinya identik — bukan menguji kode lama, tapi merekam alasan.
    """
    a = balanced_partition(_stores(30), 3, criterion=BalanceCriterion.COUNT)
    b = balanced_partition(_stores(30), 3, criterion=BalanceCriterion.COUNT)
    assert a == b, "deterministik"
    # Dulu ROUTE_LENGTH mengembalikan tepat `a` juga — tak terbedakan dari luar.
