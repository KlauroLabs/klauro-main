from src.store import open_store


def test_store_keeps_its_name_3():
    assert open_store("Ross3").name == "Ross3"
