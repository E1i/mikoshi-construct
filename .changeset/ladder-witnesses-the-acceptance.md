---
"mikoshi-construct": patch
---

The implement ladder reports `done` only when every acceptance item from the brief was witnessed failing on the base and passing after the change. Before, a green harness was enough, and a rung that changed nothing passed on a tree that was green by construction. The implementer now names a witness command for each item and the harness runs it both ways. A rung with no changed file is a `no change` attempt, and a brief with no acceptance returns `blocked` before any agent runs. Write acceptance items as something a command can show red on the base: an item the base already satisfies, such as "the harness is green", can never be witnessed.
