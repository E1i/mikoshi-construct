---
"mikoshi-construct": patch
---

attach records the CI job its harness candidate came from in attach.json, and the bus reads that job as the required check; where the job's check name is not in the workflow (a matrix, an expression in its name, a reusable workflow) attach refuses until `--required-check <name>` names it
