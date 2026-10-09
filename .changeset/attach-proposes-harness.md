---
"mikoshi-construct": minor
---

cli: `construct attach` in a terminal without `--harness` prints at most three harness candidates read from the repository's CI `run:` steps and root `package.json` scripts, each with its source (tests before typecheck, lint never), and asks yes / no / a number. On no, or when nothing is proposed, attach goes on and records `"harness": "none"` in `.construct/attach.json`, whose `recordVersion` becomes 3 (an earlier build refuses to detach it as written by a later one), and `construct doctor` reports the harness as not covered
