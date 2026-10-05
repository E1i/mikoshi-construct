---
"mikoshi-construct": patch
---

cli: `construct intake` checks every backticked command of a witness, not only the first, and counts an absolute command path as resolved only when it names an executable file.
