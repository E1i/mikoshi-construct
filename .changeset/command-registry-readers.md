---
'mikoshi-construct': patch
---

The module boundary check now reads the status of each side of an edge. An undecided module may import the contract of a decided module it names in `may_use`; without that entry, into an undecided module, or from a decided module into an undecided one, the edge stays a violation, and `may_use` never makes an import into another module's internals lawful. The modules that show the owner's commands — `atlas`, `board`, `project`, `intake` and `ui` — name `command-registry` in `may_use` and stay undecided. Two ledger rows, `boundary:board->command-registry` and `boundary:project->command-registry`, vanish and leave `contract/ratchet.json`; no row is added.
