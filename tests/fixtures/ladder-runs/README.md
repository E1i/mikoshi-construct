# What the design step actually returned

Every architect entry this repository's own `/implement` runs recorded — nine of them, from the
session journals under `~/.claude/projects/`. Unlike the rejected payloads in `../architect/`, these
are our own runs, so the briefs are kept in full and nothing needed replacing; absolute paths inside
them are made repository-relative, which is the only edit.

They are here because they contain the outcome the rejected payloads cannot show: what happens when
the design step *does* return something.

## The accounting

| Outcome | Runs | What the ladder recorded |
|---------|------|--------------------------|
| Returned a design | 3 | success, correctly |
| Returned a design in which every value is a placeholder | 2 | **success** |
| Returned nothing | 4 | failure |

The two placeholder designs are the reason this set exists. After three payloads the runtime could
not read, both runs answered with `decision: "test"`, `contractChanges: "test"`,
`compositionChanges: "test"`, `constraints: ["a"]`, `acceptance: ["a"]`, `files: ["a"]` — and the
schema accepted it, because the schema constrains shape and never content. The run went on to the
Implement phase and handed the implementer `Acceptance criteria: - a` and `Design spec from the
architect: test`. Nothing was red. Six of the nine entries produced no usable design, and only four
of those six were visible as failures.

## What this rules out

The three real designs are 10 667, 13 963 and 17 081 bytes. The largest of them was accepted on the
first attempt, with a 2481-character `decision` and 416 backticks in its values. The smallest payload
the runtime is known to have rejected, in the other fixture set, was 3436 bytes.

**So the size of the answer does not separate one that is accepted from one that is refused.** Any
remedy built on shortening the answer is aimed at something these nine runs contradict — and the two
placeholder designs are a recorded example of what shortening degenerates into when the model is
under retry pressure.

No value in any accepted design contains a raw control character. Whether the refused payloads did is
not knowable: the log kept only their first 2048 characters, which is what `../architect/README.md`
explains.

## Using the briefs

The nine `brief` fields are real task statements from this repository, of the shape that produces a
long spec, and they are the corpus any measurement of the design step should run against. Using them
rather than briefs from a private repository keeps the measurement free of someone else's material,
and costs nothing: the defect is in the shape of the output, not in the subject of the task.
