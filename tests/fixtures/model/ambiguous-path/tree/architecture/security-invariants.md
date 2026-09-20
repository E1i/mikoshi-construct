# Security invariants

| Invariant | Enforced by |
|-----------|-------------|
| No secret reaches a commit | .husky/pre-commit scans the staged diff |
| Imports respect the dependency policy | eslint.config.mjs restricts imports per boundary |
