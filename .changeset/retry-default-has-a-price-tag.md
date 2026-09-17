---
"mikoshi-construct": patch
---

The ladder no longer re-asks an agent whose response the schema rejected: `retryLimit` defaults to `0`, and the run stops with the validator's error where a person can read it. This default has a measured price tag, which is rarer than it should be.

A run was killed when the architect failed structured-output validation five times and hit the runtime's own retry cap. Re-running the identical task after the duplicated output contract was removed produced a valid spec on the first attempt. Comparing the two: the failed architect cost 3,658,281 billable tokens for nothing, the successful one 3,118,576 — so the four extra schema attempts inside a single call were worth about 135k each, not the millions they looked like. That cap belongs to the runtime and is not ours to set.

What *is* ours is `retryLimit`, and it counts whole additional agent calls. Each one repeats the agent's exploration of the repository from scratch — about three million tokens for an architect — and it cannot fix a contradiction in the brief, because the agent is not allowed to change the brief. The first attempt already carries the runtime's five internal tries; a second full call buys a rerun of the same misunderstanding at a thousand times the price of one schema retry. Stopping and showing a human the validator's complaint costs nothing and took about a minute to act on when it happened.
