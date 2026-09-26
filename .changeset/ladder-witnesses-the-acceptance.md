---
"mikoshi-construct": patch
---

The implement ladder reports `done` only when every acceptance item from the brief was witnessed failing on the base and passing after the change. Before, a green harness was enough, and a rung that changed nothing passed on a tree that was green by construction.

- Each acceptance item ends with its witness, `— witness: \`<command>\``. The witness is fixed in the brief before the run. The implementer only sees it and cannot substitute one, and `check-acceptance` stops a run whose args carry a different witness.
- The harness runs each witness twice: on the working tree, and against the base sha in a worktree of its own, never by stashing or rewriting files in the working tree.
- A brief now splits into acceptance, which must go from red to green and is the gate, and an `Invariants:` section, which stays green throughout and is held by the harness. An item such as "the harness is green" belongs in invariants.
- A rung that changes no file is a `no change` attempt. A brief with no acceptance, or an acceptance item with no witness, returns `blocked` before any agent runs.
