import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "web.settings")
django.setup()

from django.test import Client  # noqa: E402


def test_health():
    assert Client().get("/health").json() == {"status": "ok", "service": "web"}
