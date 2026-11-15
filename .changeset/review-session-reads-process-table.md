---
'mikoshi-construct': patch
---

The review no longer returns changes because its sandbox cannot read the process table. A card witness whose test name declares `[needs ps]` (read by `declaredCapabilities` in `scripts/ci/sandbox-failing.ts`) is proven by the witness node and CI, outside review. When the bus holds a green `witness.recorded` for the card on the head under review, the review prompt names each such witness. The reviewer does not run it or its mutations and records it as an isolation gap proven by the witness node, as advice that is no reason for changes on its own. Every other witness runs as before. A `[needs ps]` witness with no green record on that head also runs as before, and a sandbox refusal there stays a finding. The review sandbox itself is unchanged. `boundary:node-review->quality` in `contract/ratchet.json` goes from 4 to 5 for the one import of that parser, by the owner's decision.
