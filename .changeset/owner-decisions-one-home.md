---
'mikoshi-construct': patch
---

The owner decisions modules live in one folder, `scripts/policy/decisions/`: the bus table and its folds in `index.ts`, the import of the decisions file in `import.ts`, and `decisionsFileOf`, which `doctor` and `intake` use to find a bus's decisions file, beside the parser in `decisions.ts`. No behaviour changes.
