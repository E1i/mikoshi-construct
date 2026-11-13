---
'mikoshi-construct': minor
---

A project `construct init` generates with the node-backend or monorepo preset installs again. Since 2026-11-12, `pnpm install` in such a project refused `encodeurl@2.0.2`, which express pulls in, as a high-risk trust downgrade under the template's `trustPolicy: no-downgrade`. The generated `pnpm-workspace.yaml` now pins `encodeurl` to 2.0.0, the last release before that downgrade, and keeps `no-downgrade` for it rather than excluding the package from the trust policy. A project generated earlier that hits the refusal can add `encodeurl: 2.0.0` under `overrides` in its own `pnpm-workspace.yaml`.
