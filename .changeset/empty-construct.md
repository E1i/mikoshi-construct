---
"mikoshi-construct": minor
---

cli: `attach` no longer counts a `.construct/` directory as something to attach to: a repository holding nothing but `.construct/`, empty or not, is refused with nothing to attach, as a repository holding only a README already was
