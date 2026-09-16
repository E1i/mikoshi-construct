# Security

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/e1i/mikoshi-construct/security/advisories/new)
rather than a public issue. You will get an acknowledgement within a few days and a fix or a
decision before anything is disclosed.

In scope: the CLI itself, and any template that puts a generated project at risk — a lint rule
that silently stops enforcing an invariant, a workflow that leaks a secret, a default that widens
what leaves a service. The construct's whole premise is that security invariants are named and
checked; a template that weakens one is a security bug here, not a style issue.
