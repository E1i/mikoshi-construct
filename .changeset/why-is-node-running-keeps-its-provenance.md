---
"mikoshi-construct": patch
---

A freshly initialised project installs again. Vitest 5.0.2 depends on `why-is-node-running ^3.2.1`, which resolved to 3.2.2 — a release published without the provenance 3.2.1 carries — and the generated `trustPolicy: no-downgrade` refused it, so `pnpm install` failed on every preset. The generated `pnpm-workspace.yaml` now overrides `why-is-node-running` to 3.2.1 rather than exempting 3.2.2 from the trust check. A project already initialised can add the same `overrides` entry to its `pnpm-workspace.yaml`.
