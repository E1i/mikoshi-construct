from app import app, total


def test_health():
    assert app.test_client().get("/health").get_json() == {"status": "ok", "service": "api"}


def test_total():
    assert total([{"price": 2, "qty": 3}, {"price": 5, "qty": 1}]) == 11
