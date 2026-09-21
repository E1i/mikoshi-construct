---
"mikoshi-construct": minor
---

harness-steps names every step of the quality script the construct writes

The templates have always written `pnpm composition:check` into the `quality` script, and no fact
named it. The claim said the harness runs lint, typecheck and tests, and stood on three needles — so
it under-reported the script it was standing on, and a composition check silently dropped from that
script would not have moved the claim.

A `file-contains` fact for `pnpm composition:check` now sits under the claim, and its statement and
mechanism name the step alongside the others.

The needles are deliberately not widened to also match `pnpm run …`. A literal substring cannot tell
one invocation from the other, and one that tried would be guessing at a script the construct did
not write. The needle is the construct's signature on its own script; decision 0020 is what keeps it
honest, by checking the facts before the claim is made.

`tests/harness-steps-facts.test.ts` holds the template and the facts to each other in both
directions: every needle must be a substring of the quality script each preset renders, and every
step of that script must be named by a needle. The second direction is what the missing fact failed.
