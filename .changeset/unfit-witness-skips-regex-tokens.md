---
'mikoshi-construct': patch
---

A witness that greps a file no longer reads its pattern as a path. Before, `grep -qE '"scripts/(core|intake)/' file` named `scripts/(core|intake)` and a `-e "\"scripts/core/"` pattern named `\"scripts/core`, so intake judged the witness unfit when that "path" was absent and outside the card. A token holding a regex metacharacter, a token after `-e`, `-E` or `-F`, and a token that opens with a nested or escaped quote are now no path; the file the command reads is still one.
