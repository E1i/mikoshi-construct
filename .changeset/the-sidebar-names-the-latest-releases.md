---
"mikoshi-construct": patch
---

The documentation sidebar listed `0.5.0`, `0.4.0` and `0.3.0` under Releases — the three versions that
happen to have hand-written pages — so a visitor saw `0.5.0` as the highest number in the navigation
and concluded that was where the project stood, while the index below listed everything through the
current release. The gate added earlier was not at fault: it required every version to be reachable,
and every version was. Reachable and prominent are different properties, and only the first had been
asserted.

The sublist is now computed at config time from the same functions the index renders from, so there is
no generated artifact that can fall behind and no second writer to enumerate. A version with a
hand-written page links to that page and stays named however old it gets; a version without one links
to its own section in the index. `pnpm docs:anchors` checks those section links against the rendered
HTML after `docs:build`, because an anchor that misses still lands on the page and says nothing.
