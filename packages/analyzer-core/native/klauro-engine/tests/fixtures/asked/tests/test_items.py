from app.core.config import settings


def test_read_item(client):
    response = client.get(f"{settings.API_V1_STR}/items/{item.id}")
    assert response.status_code == 200
