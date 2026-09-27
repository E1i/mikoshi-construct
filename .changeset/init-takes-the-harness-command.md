---
"mikoshi-construct": patch
---

cli: `init` takes `--harness <command>`, as `attach` does. Without it, a repeated `init` keeps the command recorded in `construct.json` by the previous run, and a first `init` still defaults to `pnpm run quality`. The `harness-steps` claim — which spells out the pnpm scripts the harness command runs — is only born when the harness command is `pnpm run quality`; any other command leaves that claim unwritten, since the construct cannot know what it runs.
