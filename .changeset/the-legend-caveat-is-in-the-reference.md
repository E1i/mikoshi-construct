---
"mikoshi-construct": patch
---

The CLI reference carries the line the picture has carried since 0.11.1

`docs/cli.md` describes the picture's legend and the state on each entry, and stopped before the
sentence the page prints under that legend — that colour carries the derived state and not the
enforcement level, so the same green covers an L0 claim nobody is obliged to read and an L3 claim
that fails the build. Nothing in the reference was false; it was incomplete about the one thing the
page goes out of its way to say.

The reference now repeats that line rather than restating it, and a test holds both against the same
constant in `src/model/svg.ts`, so a change to the sentence cannot leave the document behind.
