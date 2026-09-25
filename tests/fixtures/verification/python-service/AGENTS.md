<!-- construct:begin -->
# py-svc-assets

Context for coding agents and automated reviewers working on py-svc-assets. This repository runs on a
construct materialized by `mikoshi-construct` v0.22.0: architecture policy in
[architecture/](architecture/), a harness that proves every change, and the rules that apply to all
code in [architecture/principles.md](architecture/principles.md). What follows is what is specific to
this repository. Sections marked "not discovered yet" are filled by construct discovery
(`/construct-discover` in Claude Code, "run construct discovery" in Cursor), then kept current by
whoever changes the thing they describe.

## What this product does

<!-- construct:discover:product -->
Two small Python HTTP services and a placeholder asset build. `services/api` is a Flask app that
answers `GET /health` and holds `total(items)`, which sums `price * qty` over a list of line items;
`services/web` is a Django project that answers `GET /health`. `package.json` predates the construct
only as `build: echo building static assets`, which produces nothing. The flow where a defect costs
the most is `total()` in `services/api/app.py`: it is money arithmetic, although no route calls it yet.
<!-- /construct:discover:product -->

## Module map

<!-- construct:discover:module-map -->
| Path | Purpose |
|------|---------|
| `services/api/` | Flask service: `app.py` builds the app, mounts `GET /health`, defines `total()` |
| `services/web/` | Django project: `manage.py` entry, `web/settings.py`, `web/urls.py` (`GET /health`) |
| `tests/` | pytest suite for both services (`test_api.py`, `test_web.py`); `pyproject.toml` puts both service directories on the path |
| `pyproject.toml`, `requirements.txt` | Python project metadata and dependency ranges (Django, Flask, pytest) |
| `contracts/api/` | OpenAPI contract written by the construct; no Python code reads it |
| `packages/shared/` | TypeScript types generated from the contract; nothing in the repository imports them |
| `scripts/` | Construct harness scripts (composition, contract types) and their Vitest tests |
| `architecture/` | Principles, checklists, security invariants, decisions, composition models |
<!-- /construct:discover:module-map -->

## Commands

```bash
pnpm dev             # run the service locally
pnpm run quality     # the harness: contract + composition checks, lint, typecheck, tests — the CI gate and the agent gate
pnpm contracts:types # regenerate packages/shared/src/api/openapi.ts after editing the API contract
pnpm composition:render # regenerate architecture diagrams after editing a composition model
pnpm lint:fix        # ESLint with --fix; ESLint is the only formatter
```

Use `pnpm run quality` / `pnpm run ci` — bare `pnpm ci` is a pnpm install builtin, not this script.

<!-- construct:discover:commands -->
```bash
pnpm build                                            # echo building static assets — a placeholder, builds nothing
python -m pytest                                      # the Python test suite (tests/, configured in pyproject.toml); not part of pnpm run quality
python services/web/manage.py runserver               # run the Django service
flask --app services/api/app.py run                   # run the Flask service
```
<!-- /construct:discover:commands -->

## Harness

`pnpm run quality` is the gate for any change. A change is not done until it passes; a pass is
reported by the harness, never by the implementer. Security invariants and the check that enforces
each one: [architecture/security-invariants.md](architecture/security-invariants.md).

## Contract

[contracts/api/openapi.yaml](contracts/api/openapi.yaml) is the HTTP contract. The service validates requests against it,
consumers read the types generated into [packages/shared/src/api/openapi.ts](packages/shared/src/api/openapi.ts), and
`oasdiff` flags breaking changes on pull requests. An API change edits the contract first, runs
`pnpm contracts:types`, then implements.

## Architecture

The principles in [architecture/principles.md](architecture/principles.md) apply; this is how they map
here.

- *Composition roots.*
  <!-- construct:discover:composition-roots -->
  `services/api/app.py` constructs the Flask `app` and mounts routes with decorators on it;
  `services/web/web/urls.py` mounts Django routes in `urlpatterns`, wired through `ROOT_URLCONF`,
  `INSTALLED_APPS` and `MIDDLEWARE` in `services/web/web/settings.py`, and `services/web/manage.py` is
  the Django entry point. A new Flask route is a decorated function on that `app`; a new Django route is
  an entry in `urlpatterns`. Each service's flow is modelled in `architecture/composition/`. There is no
  `apps/*/src/server.ts`; the baseline `pnpm dev` script targets a `@py-svc-assets/api` package that
  does not exist.
  <!-- /construct:discover:composition-roots -->
- *Dependency policy.*
  <!-- construct:discover:dependency-policy -->
  `services/api` and `services/web` do not import each other; each imports only its own framework
  (Flask, Django). `tests/` imports both, through the `pythonpath` in `pyproject.toml`. No lint rule
  enforces this: ESLint does not read Python, and the boundaries in `eslint.config.mjs`
  (`ALLOWED_WORKSPACE_IMPORTS` for `apps/api` and `packages/shared`) name directories where
  `apps/api` does not exist. Until a Python import checker is chosen, this is review-only.
  <!-- /construct:discover:dependency-policy -->
- *Composition models* and their rendered diagrams: [architecture/composition/](architecture/composition/).

## Reasoning budget

High-effort areas — a task that touches one of these is classified `high` and designed before it is
implemented (see `/implement`):

<!-- construct:discover:high-effort-areas -->
- `services/api/app.py` `total()` — money arithmetic.
- `services/web/web/settings.py` — `SECRET_KEY`, `DEBUG` and `ALLOWED_HOSTS` live here.
- The `/health` response shapes in both services — the contract in `contracts/api/openapi.yaml` describes them.
- `pyproject.toml` and `requirements.txt` — dependency ranges and the pytest path configuration.
<!-- /construct:discover:high-effort-areas -->

Always high, whatever discovery finds: [contracts/api/openapi.yaml](contracts/api/openapi.yaml),
`architecture/composition/`, `eslint.config.mjs`, and every row of
[architecture/security-invariants.md](architecture/security-invariants.md).

## Conventions the harness does not enforce

No comments in source (functional pragmas such as `eslint-disable*` and `@ts-expect-error` are
compiler input and are never removed). `async`/`await` over promise chains where the enclosing context
can be async. Tests live in `tests/**` as `*.test.ts`, never beside the source, and every new or
changed logic module ships its test in the same change. ESLint is the only formatter.

## Real defects vs accepted variance

Treat as real defects:

- A new or changed logic module with no test file.
- A response shape that drifts from the API contract, or a breaking change to a `/v1` endpoint that
  was not identified deliberately.
- A secret, API key or connection string written into any file. Config references the environment.
- Any row of [architecture/security-invariants.md](architecture/security-invariants.md) that a change
  weakens.

<!-- construct:discover:defects-vs-variance -->
- A `/health` response that differs from `HealthResponse` in `contracts/api/openapi.yaml`. Today both
  services return `{status, service}` and the contract requires `time`; nothing checks the Python
  responses against the contract.
- A change to `services/**` with no matching change under `tests/` (pytest, `test_*.py`).
- A real secret or `DEBUG = True` reaching a deployed settings file; `services/web/web/settings.py`
  holds `SECRET_KEY = "example-only"` and `DEBUG = True` as literals.
- Money in `total()` handled as floats, or `total()` wired to a route without a test for that route.

Accepted variance: Python tests are `tests/test_*.py`, not `*.test.ts`; `pyproject.toml` is excluded
from ESLint and not formatted by it.
<!-- /construct:discover:defects-vs-variance -->

Treat as accepted variance and do not report: formatting, quoting and import order (ESLint owns
them); the `.js` suffix on relative TypeScript imports (NodeNext ESM requires it); the absence of
comments or JSDoc.

## Open questions

These look like conventions but the codebase is not consistent about them. Confirm before treating
them as rules.

<!-- construct:discover:open-questions -->
- The harness does not run the Python tests. `pnpm run quality` runs Vitest over `scripts/tests/**`
  only; `python -m pytest` is run by nothing in CI.
- Which service does `contracts/api/openapi.yaml` describe? Both expose `GET /health`, and neither
  matches the contract's `HealthResponse` (`time` is required).
- The baseline `pnpm dev` script and the `apps/api` boundary in `eslint.config.mjs` refer to a
  `@py-svc-assets/api` package that does not exist. Remove them, or point them at a Python service?
- Is `SECRET_KEY = "example-only"` / `DEBUG = True` meant only for local runs? There is no
  environment-based settings split.
- Is `total()` meant to take integer minor units? `test_total` uses integers; nothing constrains the type.
- `security.yml` audits npm dependencies with `pnpm audit`; nothing audits the Python ranges in
  `requirements.txt` / `pyproject.toml`.
- The model cannot record that the harness *does not* run pytest: that needs a fact kind for the
  absence of a needle in a file (`package.json` not containing `pytest`), which would have settled
  whether the Python suite is inside the gate.
<!-- /construct:discover:open-questions -->
<!-- construct:end -->
