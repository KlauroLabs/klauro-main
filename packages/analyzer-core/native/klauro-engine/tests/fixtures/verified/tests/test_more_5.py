from src.store import open_store


def test_store_keeps_its_name_5():
    assert open_store("Ross5").name == "Ross5"
