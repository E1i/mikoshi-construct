---
'mikoshi-construct': patch
---

Known gap of this release: `construct attach` on a real repository does not yet carry cards to the end without a hand. An empty repository and `construct init` are green; on an attached repository three things remain:

1. The tsx CLI opens an IPC pipe under `/tmp` and gets `listen EPERM` in the session sandbox, so the gate of such a repository goes red on its first step (F-attached-gate-that-binds-a-port-stops-every-card).
2. A session in an attached repository does not commit. That is by design under the HIJACK law — a person commits: the change stays in the tree, with a report.
3. The sink card stops on a question before the budget fires (F-sink-asks-before-the-budget-fires).

The localhost port is already fixed: card sessions may bind localhost (sessionbind, PR #1224). Further work on attach to a real repository is the 0.47 line.
