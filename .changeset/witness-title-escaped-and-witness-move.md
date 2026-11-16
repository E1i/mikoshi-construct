---
'mikoshi-construct': patch
---

A witness's `test` title now reaches `vitest -t` as a literal match: every regex metacharacter in it is escaped, and a single quote in it stays safely quoted. Before, a title such as `[needs ps]` was read as a character class, selected no test, and the witness could never pass. Intake also accepts a witness move now: an amend that removes one witness id and adds another goes through with no downgrade wait when an owner decision for that card names the move (`W2 → W3`, `W2 -> W3`, `move W2 to W3`). Without such a decision, removing an invariant witness still waits for the owner, as before.
