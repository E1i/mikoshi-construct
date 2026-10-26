---
"mikoshi-construct": minor
---

factory: a factory in window mode now runs launch, witness, review and answer live, and merge in shadow, so the bus launches shifts, reviews and checks CI while a person merges. `construct-factory` on a fresh bus and `construct-factory --mode window` write that live set into the bus's `workers.json` with no `allow-live` word, and a round trip through ghost-protocol keeps it. A second `construct-factory` over a factory that is already running, or that another start is starting, exits 0 and names the process it left alone; it exits non-zero only when nothing serves the bus after it. `bus:run` takes `bus-run.lock` in its bus directory, and a second `bus:run` on the same bus exits non-zero naming the lock and the pid that holds it.
