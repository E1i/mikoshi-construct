---
'mikoshi-construct': patch
---

CI on a commit or a pull request is read through one pure module, `src/commands/ci/state.ts`, with no `gh` import and no spawn. The board and the port `scripts/ports/ci-reading.ts`, which holds a GitHub and an in-memory adapter, both import it, and a test fails on a read outside it. A long failed-job log now keeps its later failure block when earlier error lines would have filled the prompt, and a `gh` output over a mebibyte reads whole instead of failing.
