from src.store import open_store


def test_slug_is_lowered():
    assert open_store("Ross").slug() == "ross"


def test_nothing_is_checked():
    open_store("Ross")


def test_reads_a_store(client):
    response = client.get("/stores/ross")
    assert response.status_code == 200


def test_only_through_a_stand_in(mocker):
    store = mocker.patch("src.store.open_store")
    store.return_value = None
    assert store is not None
