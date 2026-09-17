# construct doctor

The flow below is rendered from [composition/doctor.yaml](composition/doctor.yaml). Edit the model,
then run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model
drift apart.

<!-- composition:doctor -->
`runDoctor(root)` in `src/commands/doctor/index.ts` is the composition root: it reads `construct.json`, gathers file evidence once, fans out to the three baseline verdicts — files, discovery markers, harness — and to five pure enforcement checks, then fans the verdicts into `printDoctor`, which ends with one weakest-link line. It executes nothing from the repository it inspects and writes nothing.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct doctor (citty)"]
    run["runDoctor"]
  end
  subgraph b_evidence["Evidence · file reads only"]
    manifest["readManifest → construct.json"]
    evidence["construct.json files + package.json, vitest include globs, workflows, hook configs · read only"]
  end
  subgraph b_checks["Checks"]
    files["baseline files · missing / modified (sha256)"]
    markers["discovery markers · placeholder or filled"]
    harness["quality script steps · contract paths"]
    lintPolicy["lint-policy · a policy test the harness reaches"]
    constructTests["construct-tests · recorded tests inside the runner include"]
    ci["ci · a workflow step running the harness command"]
    hook["hook · husky / lefthook / simple-git-hooks / core.hooksPath"]
    redGate["red-gate · unknown, proving it means running it"]
    weakest["weakestLink · lowest level among the claimed gates"]
  end
  subgraph b_report["Report"]
    print["printDoctor · verdicts, levels, one weakest-link line, exit code"]
  end
  cli --> run
  run --> manifest
  manifest --> evidence
  manifest -->|"fan-out"| files
  manifest -->|"fan-out"| markers
  manifest -->|"fan-out"| harness
  evidence -->|"fan-out"| lintPolicy
  evidence -->|"fan-out"| constructTests
  evidence -->|"fan-out"| ci
  evidence -->|"fan-out"| hook
  evidence -->|"fan-out"| redGate
  lintPolicy -->|"fan-in"| weakest
  constructTests -->|"fan-in"| weakest
  ci -->|"fan-in"| weakest
  hook -->|"fan-in"| weakest
  redGate -->|"fan-in"| weakest
  files -->|"fan-in"| print
  markers -->|"fan-in"| print
  harness -->|"fan-in"| print
  weakest -->|"fan-in"| print
```
<!-- /composition:doctor -->

## What decides the exit code

Only missing baseline files and harness problems make `doctor` exit 1. Modified baseline files are
expected once a project evolves and are reported as a count. Unfilled discovery markers are named as
`GLITCH` lines but do not fail the command: discovery is the agent's job, and the harness must stay
usable before it runs.
