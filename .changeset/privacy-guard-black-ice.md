---
"mikoshi-construct": patch
---

Black ICE on the package boundary: `pnpm run quality` now runs a privacy guard over `templates/`, `docs/` and `README.md`. Domains are permitted by an explicit allowlist — a denylist in a public repository names the very thing it hides — and any host in a URL or an email address is checked whatever its top-level domain. Home directory paths (`/Users/<name>`, `/home/<name>`, `~/<name>`) are refused outright, one such path is gone from the sample transcript in `docs/cli.md`, and a test asserts the published file list carries nothing under `.construct/`, `findings/` or `runs/`.
