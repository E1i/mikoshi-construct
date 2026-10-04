from orders import api, store


def test_place_order_is_stored():
    api.place_order(1, ["tea"])
    assert store.load(1) == {"id": 1, "items": ["tea"]}
