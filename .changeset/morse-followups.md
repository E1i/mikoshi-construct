---
"mikoshi-construct": patch
---

scripts: Morse counts a path as a test only under a `tests/` directory, not when the file itself is named `tests`; `predict` refuses a `--journal` inside the `--repo` or the working directory's repository and writes nothing; the diff reader refuses a git status other than A, M or D (a typechange is `T`), a path with no numstat line, and a numstat line that is neither two counts nor `-\t-`; the rule-id type is derived from `RULES`; and each refused `predict` test asserts that nothing was appended.
