# construct attach

The flow below is rendered from [composition/attach.yaml](composition/attach.yaml). Edit the model,
then run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model
drift apart.

<!-- composition:attach -->
`runAttach(ui, options, prompter)` in `src/commands/attach/index.ts` is the composition root: the refusals run first and every one of them exits before a byte is written; then the harness command comes from a flag or a prompt; then the carriers are planned, the exclude block, the nine carriers, the guard entry and the record are written in that order. `--entry` is routed in `src/program.ts` before `runAttach`, prints the entry protocol and writes nothing. Dotted edges are wiring, solid edges are the flow.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct attach (citty, alias jack-in)"]
    run["runAttach"]
  end
  subgraph b_refuse["Refuse · before any write"]
    refusals["twelve refusals, in order"]
    detect["isEmptyDir(dir)"]
    carrierset["ATTACH_CARRIERS, ATTACH_GUARD"]
    earlier["templates/attach: entry protocol, known set, classifyCollisions by sha256"]
  end
  subgraph b_configure["Configure"]
    prompts["prompter (clack) or --harness"]
  end
  subgraph b_materialize["Materialize"]
    carriers["planCarriers, directoriesToCreate"]
    plan["planMaterialize"]
    exclude[".git/info/exclude block"]
    strategies["appendBlock, gitignore markers"]
    apply["writeCarriersExclusively (wx)"]
    settings["commit guard entry · .claude/settings.local.json: read, append, write by rename"]
    record[".construct/attach.json"]
    rollback["rollbackAttach · own files by sha, exclude restored byte for byte"]
  end
  indexreader["readTrackedPaths · is the settings file tracked"]
  cli --> run
  run --> refusals
  refusals -.-> detect
  refusals -.->|"collision"| carrierset
  refusals -.->|"unreadable, guard entry already there"| settings
  refusals -.->|"settings file tracked; unreadable index"| indexreader
  cli -->|"--entry: print the protocol, nothing else runs"| earlier
  refusals -.->|"collision: sha256 per path against the known set"| earlier
  refusals -->|"none fired"| prompts
  prompts -->|"harness command"| carriers
  carriers -.-> plan
  carriers -.-> carrierset
  carriers -->|"nine targets and the settings file, after confirm"| exclude
  exclude -.-> strategies
  exclude -->|"block written"| apply
  apply -->|"carriers and guard written"| settings
  settings -->|"created flags; sha256 of each file"| record
  settings -->|"unreadable or guarded at write → refused"| rollback
  apply -->|"EEXIST → refused COLLISION"| rollback
```
<!-- /composition:attach -->

## Where the boundaries are

Refuse runs every check before a byte is written, in a fixed order, and each refusal leaves the tree
exactly as it found it — including `.git/info/exclude`. Configure takes the harness command from
`--harness` or asks for it; nothing is assumed, because the repository was not written by the
construct and its gate is not ours to guess. Materialize writes in one order — the exclude block, the
six carriers, the record — so a failure between two steps leaves a tree `git status` still reads as
clean and a record that names only what exists.
