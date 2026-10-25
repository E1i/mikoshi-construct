# INIT: a construct into a repository

`construct init` detects the repository, asks only what a flag or an existing `construct.json` leaves open,
and writes the construct: architecture policy, the harness, an API contract where the preset has one, and
the agent instructions. Every option, exit code and refusal is in the [CLI reference](/cli#construct-init).

```bash
mkdir my-service && cd my-service
npx mikoshi-construct init
pnpm install && pnpm run quality
```

- **Presets.** `node-backend`, `node-frontend`, `node-library`, `monorepo` ([CLI reference](/cli#construct-init)).
- **An existing repository** gets policy, harness tooling and agent files, never example code. Its own
  `AGENTS.md`, `CLAUDE.md`, `package.json` and configs are merged or left alone; there is no `--force`
  ([Getting started](/guide/getting-started#into-a-repository-that-already-exists)).
- **Two records come out of it.** `construct.json` is provenance; `construct.model.json` is knowledge
  ([What it refuses to claim](/guide/what-it-refuses-to-claim)).
- **The flow** is modelled in `architecture/composition/init.yaml` and described in `architecture/init.md`
  ([Architecture](/guide/architecture/init)).
- **After init** the agent runs discovery, and `construct atlas` maps the result ([the atlas](/atlas-guide)).
