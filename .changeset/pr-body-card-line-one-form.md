---
"mikoshi-construct": patch
---

card: `readBodyCard` in `src/card/grammar.ts` is the one reader of a pull request body's card line, accepting the line with or without a leading `card: `; `shift:merge` (merge, verdict and `--carry`), `task:merged` and `task:close` read the body through it, so a body opening with `card: #N …` is no longer refused as "not a card". The line is still written in one form, `cardLine`, without the prefix
