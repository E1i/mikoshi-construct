# Security invariants

| Invariant | Enforced by |
|---|---|
| No secret is committed | `.github/workflows/security.yml` runs gitleaks on every push and pull request |
