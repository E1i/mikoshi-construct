---
'mikoshi-construct': patch
---

A version pull request is red until a consumer smoke has gone green on its head. `scripts/release/consumer-smoke.ts` builds a scratch consumer with `construct init` and runs the launch, answer, review and window sessions there. Each session runs the first step of every capability it claims: `browser-lab page --shot` at its installed absolute path, `codex exec`, a `gh` read and a `git commit` in its card branch. The card session also pushes and opens a pull request. The script records each step's exit code and output, and posts `construct/consumer-smoke` as a commit status of at most 140 characters that names each role and capability that failed. The launch and answer sessions start with the sandboxed policy that the product's own launch paths build. The CI version-pull-request guard reads that status with `GH_TOKEN` and `statuses: read`. A missing, failed or unrecognised state keeps the version pull request red.
