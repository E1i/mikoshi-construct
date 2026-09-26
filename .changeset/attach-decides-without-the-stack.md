---
"mikoshi-construct": patch
---

`attach` no longer reads the stack. It refused a repository whose detected layout was `empty` or `unknown`, and that detector reads directory names: a Go repository with a `services/` directory attached, while the same repository without it was refused (#232). Now a repository with anything in it attaches whatever it is written in. Only a tree holding nothing but `.git` and the files an empty directory may hold is refused, as `Refused: this repository holds nothing to attach to.` Whether the harness you name covers the code is what `doctor` reports afterwards (decisions 0033 and 0034).
