---
"mikoshi-construct": patch
---

Edge labels in the rendered picture cannot sit on top of each other

The picture's stage labels were separated only where two edges ran between the same pair of nodes.
Labels belonging to different claims were not touched, and on this repository's own model they stood
9 pixels apart in one column — the same illegible overprint the parallel-edge fix was meant to end,
arriving by a route that fix did not cover.

Label placement now excludes the collision by construction rather than detecting it: an anchor that
would land within one line height of an already-placed one is pushed clear before it is written, so
no rendered file can contain the forbidden state.

`tests/edge-labels-do-not-collide.test.ts` holds the property, taking the threshold from the
renderer's own constant rather than repeating a number, and its own description says what it holds:
**distance, not readability**. Readability was found by a person opening the file, and a green suite
here is not a claim that the picture reads well — only that no two labels are closer than a line.
