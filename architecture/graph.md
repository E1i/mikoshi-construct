# construct graph

The flow below is rendered from [composition/graph.yaml](composition/graph.yaml). Edit the model, then
run `pnpm composition:render`; `pnpm composition:check` fails when the diagram and the model drift
apart.

<!-- composition:graph -->
`construct graph` draws what a repository claims and the evidence under it. `modelPicture` in `src/commands/graph.ts` resolves the directory, reads `construct.model.json` through `readModel` — which refuses a record written by a later build rather than reading it partially — and derives the state of every claim and hypothesis with `deriveModelState`, which looks only at the files that file-kind facts name. It withholds a runner's report, because reading one needs the paths `construct.json` records and `graph` never reads `construct.json`; `graphOfModel` draws every report-backed fact, claim and hypothesis in the fixed class runtime-report. `printGraph` writes the Mermaid text to stdout, and that is the only rendering: the page that can be opened is the Atlas, which `construct atlas` builds. A repository with no model, or a model holding nothing, is a state rather than an error — the picture carries where it stopped, `printGraph` says so in one line, and the command exits 0 having drawn nothing. `graph` writes no file.

```mermaid
flowchart LR
  subgraph b_entry["Entry"]
    cli["construct graph (citty)"]
    picture["modelPicture · resolve the directory"]
  end
  subgraph b_read["Read · the model, and the files its facts name"]
    read["readModel → construct.model.json · absent is a state, not a failure"]
    schema["MODEL_FILE, modelVersion · a model ahead of the reader is refused"]
  end
  subgraph b_derive["Derive"]
    state["deriveModelState · each claim and hypothesis against the facts named under it · a runner's report is withheld; report-backed entries are drawn as runtime-report"]
    graph["graphOfModel / pictureOfModel · nodes, edges, where the chain stops"]
  end
  subgraph b_render["Render"]
    mermaid["printGraph → Mermaid on stdout"]
  end
  cli --> picture
  picture --> read
  read -.-> schema
  read --> state
  state --> graph
  graph -->|"stdout"| mermaid
```
<!-- /composition:graph -->

## One reading, one rendering

`construct.model.json` is read once and the state of every claim and hypothesis is derived once, from
the files the facts under it name. The Mermaid text on stdout is the one rendering of that reading.
Nothing downstream of `deriveModelState` opens a file. The page a person opens is the Atlas, which
[construct atlas](atlas.md) builds from the Engram; `graph` has no page of its own.

## Nothing to draw is a state

A repository with no `construct.model.json`, or one whose model carries no facts, claims or
hypotheses, is not an error. `pictureOfModel` carries where the chain stopped, `printGraph` prints the
prose for that stop in one line and returns 0. The command that draws nothing and the command that
fails are told apart by what they print, not by the exit code — there is no state in which `graph`
invents a node.

## It writes nothing

`graph` inspects a repository the way `doctor` does, executing nothing from it, changing nothing in it
and writing no file anywhere: the diagram goes to stdout and the messages to stderr.
