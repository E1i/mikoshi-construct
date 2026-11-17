---
'mikoshi-construct': patch
---

Lane order on a shared file follows release priority, never admission time. A card is never chained behind a card that depends on it, directly or through its depends, and a card of better priority (its own, or the best of the cards it blocks) is never chained behind a waiting card of worse priority; a readmitted card takes its place in that order. A queued card already in the lane is chained again behind a card that now comes before it. A started card keeps its place, and cards of one priority keep the chain they were given.
