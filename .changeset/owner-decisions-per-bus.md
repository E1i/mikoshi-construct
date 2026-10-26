---
"mikoshi-construct": minor
---

factory: owner decisions and the owner's words now belong to the bus of their repository. A repository bus `~/.construct/<repo-id>/bus.db` reads and writes `~/.construct/<repo-id>/owner-decisions.md` and accepts an owner word only from `~/.construct-owner/answers/<repo-id>/`, which is where `construct say` writes when run in that repository; the machine bus `~/.construct/bus.db` keeps `~/.construct/owner-decisions.md` and `~/.construct-owner/answers/`. A decision or a word given for one repository, an `allow-live` included, no longer reaches another repository's factory. A `tree.cut` requested right after `construct intake --admit` is no longer refused for a card body the bus had not applied yet.
