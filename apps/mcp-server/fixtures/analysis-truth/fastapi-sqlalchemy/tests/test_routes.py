from app.main import app


def test_app_routes_registered():
    paths = [route.path for route in app.routes]
    assert any('/' in path for path in paths)


def test_app_title_present():
    assert app.title
