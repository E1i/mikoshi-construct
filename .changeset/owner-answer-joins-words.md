---
'mikoshi-construct': patch
---

`owner:answer <Q<N>|#N> word word ...` no longer needs quotes: every argument after the target is joined into one text with single spaces, and typographic quotes (« » “ ” ‘ ’) at the two ends of that text are stripped, so a phone's smart quotes give the same word as plain or no quotes. The command prints its usage and exits 2 only when the target is missing or is not `Q<N>` or `#N`, or when no word remains.
