from src.store import open_store


def test_store_keeps_its_name_1():
    assert open_store("Ross1").name == "Ross1"
