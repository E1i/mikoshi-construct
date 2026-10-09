# Factory state

The factory's state lives in four files under `~/.construct` (`$CONSTRUCT_HOME`). Each concern has one authoritative
file; everything else is a projection derived from them, and a projection is never a source.

| Concern | Authoritative file |
|---|---|
| events | the journal, `~/.construct/handoff/ghosts.jsonl` |
| decisions | `~/.construct/owner-decisions.md`, read with `pnpm decisions` or `pnpm state decisions` |
| cards | the parking, `~/.construct/parking/**/<id>.md` |
| the Operator's current state | the handoff |

## Writes

A session writes state only through `pnpm state:*`, never through `python3`, `node -e` or an editor:

- `pnpm state:note <task> <text>` — a note, as an `event:note` line in the journal;
- `pnpm state:decision <text> [--cards #A #B]` — the next numbered owner decision;
- `pnpm state:card <lane>/<id>.md <draft.md>` — a parked card, when the draft parses;
- `pnpm state:handoff <handoff.md> <draft.md>` — the handoff, through `pnpm handoff:write`.

Each takes the write lock `~/.construct/state/write.lock` (created exclusively, holding its PID; a lock whose PID is dead
is taken over under `write.lock.takeover`), writes the authoritative file whole (a temporary file renamed over it) and
appends an `event:state` line — `write`, `file`, the file's `sha256` — to the journal, so two writers run one after the
other and neither is lost. A note's authoritative file is the journal itself. Every `state:*` command is an allow rule of
`contract/factory-permissions.json`.

## Reads

`pnpm state <decisions|queue|inflight>` prints a view from its projection, `~/.construct/state/<view>.json`. A projection
stores its schema version, the fingerprint of its source (the journal's byte offset and a sha256 over the
authoritative files it reads) and a seal over both and its lines, and is written atomically. A projection of another
schema, with a broken seal, or whose fingerprint does not match its source is rebuilt from the source. An unchanged
journal size, newest source mtime and source count is only the fast check that skips hashing.

## Checks

`pnpm doctor:factory` names every state file whose content is not the one its last `event:state` line recorded — a
write that bypassed `state:*` — and every stored projection whose fingerprint matches its source but whose lines
differ from the view rebuilt from scratch. A file no `state:*` command has written yet is not checked.

The Operator's start prompt (`scripts/shift/relaunch.ts`) carries the three views; other prompts move over once the
measurement under `~/.construct/probes/738-state-views/` decides it.
