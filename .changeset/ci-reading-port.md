---
'mikoshi-construct': patch
---

CI on a commit or a pull request is read through one port, `scripts/ports/ci-reading.ts`, with a GitHub and an in-memory adapter and a test that fails on a read outside it. A long failed-job log now keeps its later failure block when earlier error lines would have filled the prompt, and a `gh` output over a mebibyte reads whole instead of failing.
