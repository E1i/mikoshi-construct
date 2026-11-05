---
'mikoshi-construct': patch
---

A session the bus starts takes a named list of environment variables instead of the bus's whole environment: `PATH`, `HOME`, `TMPDIR`, `LANG`, `PNPM_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, the proxy variables, `USER`, `LOGNAME`, `SHELL`, `TERM`, `GH_TOKEN`, `NODE_EXTRA_CA_CERTS`, and anything starting with `CONSTRUCT_`, `CLAUDE_`, `ANTHROPIC_` or `LC_`. Anything else set in the bus's environment no longer reaches a card, answer, review or ladder session; a repository whose gate or hooks read such a variable sees it unset there.
