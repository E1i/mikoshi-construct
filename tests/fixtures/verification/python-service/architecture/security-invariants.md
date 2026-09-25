# Security invariants

Security is its own review dimension. Each invariant names what enforces it; `review` means the
reviewer is the only check, so weigh those the most. A finding that recurs is an architectural
problem: move the protection to a shared boundary and add a check rather than fixing the symptom
again. Method: [principles.md § Security](principles.md#security).

The baseline rows below are enforced by files this construct materialized. Discovery adds the rows
that are specific to this system — the ones where money, identity or data can be corrupted.

| Invariant | Enforced by |
|-----------|-------------|
| No secret, token or connection string in any file, including gitignored ones; config references `${VAR}` placeholders | `.github/workflows/security.yml` runs gitleaks over the history on every push and pull request (`.gitleaks.toml` keeps the default ruleset live); review |
| Dependencies with known high-severity vulnerabilities are visible | `security.yml` runs `pnpm audit` weekly and on pull requests, reporting only |
<!-- construct:discover:security-invariants -->
| Django serves only the hosts in `ALLOWED_HOSTS` (`example.com`, `testserver`) | Django's host validation reading `services/web/web/settings.py`; review for changes to that list |
| `SECRET_KEY` and `DEBUG` come from the environment in any deployed service | review — `services/web/web/settings.py` holds both as literals today, and nothing checks it |
| `total()` sums `price * qty` exactly | `tests/test_api.py::test_total` (integers only), run by pytest, which `pnpm run quality` does not run; review |
| Each `/health` response matches `HealthResponse` in `contracts/api/openapi.yaml` | review — no test validates the Python responses against the contract, and both responses currently omit `time` |
<!-- /construct:discover:security-invariants -->
