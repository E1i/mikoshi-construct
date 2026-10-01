---
"mikoshi-construct": minor
---

templates: the /implement ladder reads its args by path and sha256 — check-acceptance build --out writes .construct/implement-args.json and prints a handle, the Workflow receives the handle and never the file, the harness reports the file's sha256 on every call and extracts each witness through a witness mode that refuses another hash, and a mismatch ends the run as args unverified
