# construct init

The flow below is rendered from [composition/init.yaml](composition/init.yaml). Edit the model, then
run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model drift
apart.

<!-- composition:init -->
`runInit(ui, options, prompter)` in `src/commands/init.ts` is the composition root: the four phases run in this order, every module is called from there, and nothing else writes to the target directory. Dotted edges are wiring, solid edges are the flow.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct init (citty)"]
    run["runInit"]
  end
  subgraph b_detect["Detect · facts only"]
    detect["detect(dir)"]
    pm["package manager, pnpm version"]
    layout["layout, workspace packages"]
    existing["existing files, composition dir"]
  end
  subgraph b_configure["Configure"]
    prompts["prompter (clack) or flags"]
    preset["preset groups + vars"]
  end
  subgraph b_materialize["Materialize"]
    plan["planMaterialize"]
    templates["listTemplateFiles, render"]
    strategies["create / merge-json / append-block"]
    rules["Claude rules → Cursor rules"]
    apply["applyPlan"]
    manifest["construct.json"]
    model["construct.model.json"]
  end
  cli --> run
  run --> detect
  detect -->|"fan-out"| pm
  detect -->|"fan-out"| layout
  detect -->|"fan-out"| existing
  detect -->|"report"| prompts
  prompts -->|"choices"| preset
  preset -->|"groups, vars"| plan
  plan -.-> templates
  plan -.-> strategies
  plan -.-> rules
  plan -->|"FileOp[] after confirm"| apply
  run -->|"readManifest: the record already here"| manifest
  apply -->|"written files"| manifest
  preset -->|"claims the construct materializes"| model
```
<!-- /composition:init -->

## Where the boundaries are

Detect returns facts and never interprets the repository — anything that needs judgement is a
discovery marker for the agent. Configure turns flags or prompts into a preset and its variables.
Materialize plans every file before writing one: the plan is what `--dry-run` prints, and the
manifest records the hashes of what was written so `doctor` can tell modified from missing.
