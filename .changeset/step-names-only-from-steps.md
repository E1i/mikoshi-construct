---
"mikoshi-construct": patch
---

cli: `construct cost` takes a run's step only from the agent's workflow phase, never from its type; an agent whose phase is not a step is reported unread and its run is not written to the step cache
