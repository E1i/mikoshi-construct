---
"mikoshi-construct": patch
---

cli: `construct intake` no longer adds the tests that cover a card's touched files to its touches. It writes them on a `Runs:` line of the card body instead: the tests the card runs, which it may also change. Two cards that share only runs are no longer counted as overlapping. A test the card must carry as a companion, such as `tests/harness-membership.test.ts` for `package.json`, stays in touches.
