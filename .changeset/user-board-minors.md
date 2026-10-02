---
"mikoshi-construct": patch
---

cli: `construct board` reads a `--prs` list with a null check as unreadable and still prints the board (exit 0), keeps pull request titles whole, and sorts a time ahead of now as the newest in its group
