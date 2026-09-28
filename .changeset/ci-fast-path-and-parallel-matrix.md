---
"mikoshi-construct": patch
---

CI: the preset matrix starts beside `quality` instead of after it, from a tarball built by its own `package` job, and a pull request that changes only `docs/**` or top-level `architecture/*.md` takes a fast path that skips the package and the matrix while every check reading those files still runs. The allow-list lives in `scripts/ci/fast-path.ts`.
