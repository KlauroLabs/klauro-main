from src.store import open_store


def test_store_keeps_its_name_2():
    assert open_store("Ross2").name == "Ross2"
