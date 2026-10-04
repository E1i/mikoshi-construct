from orders import store


def place_order(order_id: int, items: list[str]) -> dict:
    order = {"id": order_id, "items": items}
    store.save(order_id, order)
    return order
