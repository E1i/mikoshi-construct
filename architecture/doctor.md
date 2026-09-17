# construct doctor

The flow below is rendered from [composition/doctor.yaml](composition/doctor.yaml). Edit the model,
then run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model
drift apart.

<!-- composition:doctor -->
`runDoctor(root)` in `src/commands/doctor/index.ts` is the composition root: it reads `construct.json` through `upgradeManifest`, gathers file evidence once, fans out to the four baseline verdicts — files, discovery markers, marker provenance, harness — and to five pure enforcement checks — plus the version gap, which replays today's templates through the sync engine's own classification and counts the paths a sync would add or update — then fans the verdicts into `printDoctor`, which ends with one weakest-link line. Provenance and the version gap are reported, never gated: neither sets an exit code, and a replay that cannot run leaves the count unestablished rather than failing the command. `doctor` executes nothing from the repository it inspects and writes nothing, including the manifest it just normalised.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct doctor (citty)"]
    run["runDoctor"]
  end
  subgraph b_evidence["Evidence · file reads only"]
    manifest["readManifest → construct.json · upgradeManifest normalises a 0.1.x manifest on read"]
    evidence["construct.json files + package.json, vitest include globs, workflows, hook configs · read only"]
  end
  subgraph b_checks["Checks"]
    files["baseline files · missing / modified (sha256)"]
    markers["discovery markers · placeholder or filled"]
    provenance["marker provenance · recorded sha vs the body today → construct / owner / unknown"]
    harness["quality script steps · contract paths"]
    versionGap["version gap · materialized by / read by · sync classification counts add + update"]
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
  manifest -->|"fan-out"| provenance
  manifest -->|"fan-out"| harness
  manifest -->|"fan-out"| versionGap
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
  provenance -->|"fan-in"| print
  harness -->|"fan-in"| print
  versionGap -->|"fan-in"| print
  weakest -->|"fan-in"| print
```
<!-- /composition:doctor -->

## What decides the exit code

Only missing baseline files and harness problems make `doctor` exit 1. Modified baseline files are
expected once a project evolves and are reported as a count. Unfilled discovery markers are named as
`GLITCH` lines but do not fail the command: discovery is the agent's job, and the harness must stay
usable before it runs. Marker provenance is reported on the same terms — the markers still reading
back word for word what discovery wrote are named, and naming them changes no exit code. It is a
sixth thing doctor says, never a sixth gate.
