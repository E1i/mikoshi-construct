---
"mikoshi-construct": minor
---

templates: `construct attach` now writes a second file beside the commit guard, `.construct/shell-parser.mjs`, which holds the guard's reader of the command line, and `construct detach` removes it; the guard imports it inside the checked call, so a missing parser refuses with exit 2, and the refusals are unchanged.
