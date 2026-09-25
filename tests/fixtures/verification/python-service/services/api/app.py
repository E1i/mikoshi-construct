from flask import Flask

app = Flask(__name__)


@app.get("/health")
def health():
    return {"status": "ok", "service": "api"}


def total(items):
    return sum(item["price"] * item["qty"] for item in items)
