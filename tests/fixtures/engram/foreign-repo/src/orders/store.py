ORDERS: dict[int, dict] = {}


def save(order_id: int, order: dict) -> None:
    ORDERS[order_id] = order


def load(order_id: int) -> dict | None:
    return ORDERS.get(order_id)
