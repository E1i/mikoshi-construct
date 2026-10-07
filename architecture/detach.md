# construct detach

The flow below is rendered from [composition/detach.yaml](composition/detach.yaml). Edit the model,
then run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model
drift apart.

<!-- composition:detach -->
`runDetach(ui, options)` in `src/commands/detach/index.ts` is the composition root: every read — the record, the exclude block, the git index, the class of each recorded file, the kept copy of the settings file (path confined, sha256 checked) and the classification of the runtime files — happens before any write, and each refusal leaves the tree as it found it; then the guard entry (restored from the copy or cut), the files, their emptied directories, the runtime files, the run directories, `.construct/browser`, the copy, the exclude block and the record are removed in that order. Dotted edges are wiring, solid edges are the flow.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct detach (citty, alias jack-out)"]
    run["runDetach"]
  end
  subgraph b_read["Read · before any write"]
    record["readAttachRecord"]
    exclude["pathsInExcludeBlock, removeExcludeBlock"]
    indexreader["readTrackedPaths · .git/index, .git/config"]
    copy["pre-image: path confined, sha256 checked; mismatch → refused"]
  end
  subgraph b_classify["Classify"]
    classify["adopted → absent → changed → remove"]
    settings["guard entry: adopted → absent → changed → remove"]
    runtime["runtime files: on the list, untracked, not held at attach"]
    runtimelist["ATTACH_RUNTIME_FILES"]
  end
  subgraph b_remove["Remove"]
    restore["guard entry out: the copy's bytes when the file is as attach left it, else cut"]
    remove["files by sha, empty directories, runtime files, run directories, .construct/browser, exclude block, record"]
    strategies["removeBlock"]
    directories["removeEmptyDirectories"]
    original["drop the copy, its key directory, the attach directory when empty"]
  end
  cli --> run
  run --> record
  run -.->|"block paths"| exclude
  run -->|"record found; unreadable index → refused"| indexreader
  indexreader -->|"tracked set"| classify
  classify -->|"then the guard entry"| settings
  settings -->|"then the kept copy"| copy
  copy -->|"then the runtime files"| runtime
  runtime -->|"nothing changed; entry out first"| restore
  restore --> remove
  indexreader -.->|"tracked set"| settings
  indexreader -.->|"tracked set"| runtime
  runtime -.-> runtimelist
  remove -.-> directories
  remove -->|"after .construct/browser, before the exclude block"| original
  remove -.-> exclude
  exclude -.-> strategies
```
<!-- /composition:detach -->

## Where the boundaries are

Read happens in full before a byte is written: the record, the paths in the exclude block, the tracked
set from `.git/index`, and the class of every recorded file. Each refusal — a block without a record,
an index this reader cannot parse, a carrier whose bytes changed — returns from inside Read and leaves
the tree exactly as it found it. Classify names four classes in one fixed order, adopted first, so a
carrier git tracks is the owner's whatever its bytes. The guard entry in `.claude/settings.local.json` is classed after the
files and taken out before them. Remove takes the files, then the recorded
directories that emptied, then the block attach added to `.git/info/exclude`, then the record; a file
the record does not list is never deleted and is named in the report, except the closed list
`ATTACH_RUNTIME_FILES`, and only when untracked and not held at attach; `.construct/` itself goes only
when attach created it and it is empty.
