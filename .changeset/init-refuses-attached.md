---
"mikoshi-construct": minor
---

cli: `init` refuses a repository that `attach` holds — with `.construct/attach.json` present, readable or not, it writes nothing and says to run `construct detach` first.
