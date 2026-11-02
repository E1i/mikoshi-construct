---
"mikoshi-construct": patch
---

`construct intake` counts a path listed under a card's `creates` as part of the tree a witness reads. A witness such as `grep -qx alpha zerotouch/alpha.md`, over a file the card makes, is no longer marked unclear as reading nothing the head can change. Intake now marks unclear an implement card's witness that is meant to be red on the base but names no path of the repository and none the card creates, such as `pnpm exec changeset status` stated to fail on base. A whole-tree command like that is green on a clean base, so it cannot be red there.

The witness check that runs a card's witnesses on the base and on the head (P7 in the bus witness node and the ladder preflight) now takes a witness whose every named path is a file the head adds as a change witness. It is red on the base and green on the head, so it no longer stops on the base as a failing invariant waiting for an owner word. Intake and P7 read the paths a witness names in the same way.
