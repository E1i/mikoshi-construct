---
'mikoshi-construct': patch
---

`node --import tsx scripts/contract/module-graph/report.ts` prints one machine report of the module graph: the report version and a `sha256` version of the spec, the files and their holder, the modules, the file imports and the module edges, the violations with their reasons, the cycle components with an example chain each, and the `may_use` cycles. Two runs on one commit print the same bytes: every list is in an explicit sorted order, and the report holds no timestamp, absolute path or random id. Its statistics count an import once; the reasons sit in a table of their own, marked that one import may carry several, so their counts do not add up to the violating imports. The spec and `contract/ratchet.json` do not change.
