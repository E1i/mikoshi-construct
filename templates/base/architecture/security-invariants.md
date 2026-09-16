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
_Not discovered yet — run `/construct-discover`._
<!-- /construct:discover:security-invariants -->
