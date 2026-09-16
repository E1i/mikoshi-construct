---
"mikoshi-construct": patch
---

cli: a `pnpm-workspace.yaml` or `workspaces` field counts as a monorepo only when it lists packages.
Since pnpm 10 that file also carries settings such as `minimumReleaseAge` and `allowBuilds`, and the
construct ships one in every preset, so a generated single-package project reported itself as a
monorepo and a second `init` suggested the wrong preset.
