from src.store import open_store


def test_store_keeps_its_name_4():
    assert open_store("Ross4").name == "Ross4"
