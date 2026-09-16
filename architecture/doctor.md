# construct doctor

The flow below is rendered from [composition/doctor.yaml](composition/doctor.yaml). Edit the model,
then run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model
drift apart.

<!-- composition:doctor -->
`runDoctor(root)` in `src/commands/doctor.ts` is the composition root: it reads `construct.json` and derives three verdicts from it — baseline files, discovery markers, harness — then `printDoctor` turns them into `CONSTRUCT STABLE` or a named `GLITCH` list with exit code 1. Nothing is written.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct doctor (citty)"]
    run["runDoctor"]
  end
  subgraph b_checks["Checks · read only"]
    manifest["readManifest → construct.json"]
    files["baseline files · missing / modified (sha256)"]
    markers["discovery markers · placeholder or filled"]
    harness["quality script steps · contract paths"]
  end
  subgraph b_report["Report"]
    print["printDoctor · STABLE or GLITCH, exit code"]
  end
  cli --> run
  run --> manifest
  manifest -->|"fan-out"| files
  manifest -->|"fan-out"| markers
  manifest -->|"fan-out"| harness
  files -->|"fan-in"| print
  markers -->|"fan-in"| print
  harness -->|"fan-in"| print
```
<!-- /composition:doctor -->

## What decides the exit code

Only missing baseline files and harness problems make `doctor` exit 1. Modified baseline files are
expected once a project evolves and are reported as a count. Unfilled discovery markers are named as
`GLITCH` lines but do not fail the command: discovery is the agent's job, and the harness must stay
usable before it runs.
