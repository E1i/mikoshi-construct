# 0004 — Template hygiene uses an allowlist, not a denylist

Status: accepted · 2026-09-17

## Context

A real domain belonging to the maintainer reached a public repository inside a template file, and
had been sitting in the template since the first day of the project. The reflex fix is a denylist:
the names and domains that must never appear in `templates/`.

A denylist committed to a public repository names exactly what it was meant to keep out of a public
repository.

## Decision

CI checks `templates/`, `docs/` and `README.md` against an allowlist. Permitted: `example.com`,
`example.org`, `example.net`, `localhost`, `127.0.0.1`, and an explicit list of infrastructure
domains already linked from the documentation. Anything else fails the build.

Home-directory paths (`~/<name>`, `/Users/<name>`, `/home/<name>`) are rejected the same way, and
`npm pack --dry-run` must not contain `.construct/`, `findings/` or `runs/`.

## Consequences

Adding a legitimate link means editing the allowlist in the same change. That friction is the
point: a new outbound domain in a template is a decision, not a typo.

False positives are cheap and loud — a failed build, fixed in one line. The false negative is what
already cost a force-push of a public repository's history.

## Enforced by

A CI check with negative fixtures, one per rule (L4 once it blocks merge).
