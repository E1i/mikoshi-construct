---
'mikoshi-construct': patch
---

Intake and the witness node now read the paths of a witness command in one place, `src/commands/test-runner.ts`, so they no longer judge the same witness differently. Before, intake read the name after `-t` as a path, so a red-on-main replacement with a slash in its test name went to an owner wait. It also ignored the path in `--dir=foo/bar`. Both now read a `-t` name as no path and a `--flag=path` value as the path it holds, the way the witness node already did.
