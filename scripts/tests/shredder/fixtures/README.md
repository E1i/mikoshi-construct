# Shredder fixtures

Each directory here is a **snapshot**: everything Shredder reads, and the `expected.json` it must print with `--json`.
`day-2026-09-27/` is the corpus, the day's seven tasks. `rules/<id>-pos/` makes exactly rule `<id>` fire. `rules/<id>-neg/`
is its twin, differing only in the input the rule reads, where the rule must not fire.

The pair `rules/<id>-pos` and `rules/<id>-neg` is the test of rule `<id>`. There are no separate unit tests for the
rules: `scripts/tests/shredder/cli.test.ts` runs every directory under `rules/` against its `expected.json`, so a rule
is covered exactly when its pair is here.

Every `expected.json` was written by hand from an independent reading of its inputs. None was produced by running
Shredder. The corpus was checked against the frozen hand-run matrix of 2026-09-27 and against
`gh pr view <N> --json files` for PR #264, PR #270, PR #272, PR #273, PR #274, PR #275 and PR #276.

## Snapshot layout

| Path | What it is |
|---|---|
| `tasks/NN-<id>.brief.md` | A brief: the approved `/implement` text, optionally preceded by a line `Worktree: <path>` |
| `tasks/NN-<id>.issue.md` | An issue: a title and a line `Paths: <item>; <item>`, where each item is a glob, optionally in backticks |
| `files.txt` | The tracked files, one per line (`git ls-files` at the snapshot's commit) |
| `open-prs.json` | `[{ number, title, runsAwaitingApproval, files }]`, the open pull requests with their changed files |
| `status.md` | The window table (header starts `\| window \| tree \| state \|`) and the policy table (header starts `\| policy \| value \|`) |
| `owner-merges.md` | The owner-merged kinds (header starts `\| kind \| paths (globs) \|`) |
| `expected.json` | The expected `--json` output. Shredder does not read it |

`NN` is the queue order. A task's name is `#<id>` when `<id>` is all digits, otherwise `<id>` itself (`b4`,
`xs-lint-policy`).

In `owner-merges.md` the paths cell holds globs in backticks, or a title in `«…»` (the kind is then matched by a pull
request's title, and a task never matches it), or neither. A cell with neither is empty: that kind is listed in
`notChecked`.

A glob's `*` matches within one path segment and `**` matches across segments. A glob or a path item that matches no line
of `files.txt` contributes nothing.

## Reading a task

- `node scripts/construct/check-acceptance.mjs build --brief <file>` gives the effort (its first word, `null` when
  empty), the witnesses and the Immutable items, for briefs and issues alike. The refusal
  `the brief has no Acceptance: section` (the brief's "no acceptance") means zero witnesses, no effort and no
  Immutable items. Every issue here gets that refusal.
- A brief's write set comes from its Design section, from the `Design:` line to the next label the build mode
  recognises. A **token** is a maximal run of the characters `A–Z a–z 0–9 . _ / -`, with trailing dots removed. So
  `src/model/coverage.ts:33–37` yields `src/model/coverage.ts`, and `(coverage.ts,` yields `coverage.ts`. A token counts
  when it equals a line of `files.txt`, or when exactly one line ends with `/` followed by the token.
- An issue's write set is its `Paths:` items, each expanded over `files.txt`.

### The directory-token boundary

A token that names a directory (`src/model/`, `tests/`) contributes nothing, and neither does a token matching several
files or none. So when two tasks both write existing files under a directory without naming those files, Shredder
reports them as parallel although they collide. It fails open.

Two more consequences of the token rule show up in the corpus:

- A root file named in prose counts as written. #249 gains `construct.json`. #267 gains `eslint.config.mjs` and
  `package.json`. None of them causes an edge today.
- A file that does not exist at the snapshot (`src/model/test-report.ts` in B4, `tests/model-foreign-harness.test.ts` in
  the XS issue) contributes nothing. Two tasks that create the same new file are not ordered.

## The path set

The path set is the write set, plus companions, plus tests, minus Immutable. JSON `paths.write` holds it, sorted by
code unit and without duplicates.

1. The write set, as above.
2. Companions: when `src/program.ts` is in the set, add `contract/surface.json` and every `tests/fixtures/cli-help/*.txt`.
3. Tests: for each write-set path ending in `.ts`, every line of `files.txt` matching `tests/<basename>*.test.ts`, where
   the basename is the file name without `.ts`. The match is by prefix, so `runtime.ts` brings in
   `tests/runtime-externals.test.ts` (#263).
4. Remove every path equal to an Immutable item, or under one that ends in `/`. #266 loses `tests/init.test.ts` this way.

JSON `paths.immutable` holds the Immutable items as the build mode returns them, in brief order.

The hot list is `src/program.ts`, `src/ui/lore.ts` and `contract/surface.json`.

## Rules and their `why` entries

`why` lists entries in this order: S1/S2 in the order of `contour.after`, then S3, S4, S5, the K entry, owner-merges (in
the order of the kinds in the file), free-writers, and release-gate. Path lists inside an entry are sorted and joined with
`, `.

| Rule | Fires when | `why` entry | Effect |
|---|---|---|---|
| S1 | The path set meets an earlier task's path set, or an open non-version PR's `files` | `S1 after <task or PR #N>: <shared paths>` | `after` gains the task or `PR #N` |
| S2 | As S1, and the shared paths include a hot file | `S2 after <task or PR #N>: <hot files shared>` | as S1 |
| S3 | Other tasks have a path set disjoint from this one | `S3 parallel with <tasks>` | `parallelWith` |
| S4 | A `chore: version packages` PR with `runsAwaitingApproval: false` is open | `S4 PR #N` | lock `no merge until PR #N` |
| S5 | A status row in `writing` or `reviewing` has the task's worktree as its tree (compared as written) | `S5 window X: <tree>` | lock `tree held by window X` |
| S6 | — | no entry | Constrains what an edge can point at: only a task still in the queue or a PR still open. A merged predecessor is absent from both, so no edge remains |
| K1 | The effort is not null | `K1 Effort: <effort>` | class `R2`, executor `ladder` |
| K2 | No effort and at least one witness | `K2 witnesses: <n>` | class `R1.5` |
| K3 | No effort, no witness, and every path is a `.md` outside `.claude/` and `templates/`, or is under `tests/` | `K3 docs: <paths>` | class `R1` |
| K4 | No effort, no witness, and some path fails K3 | `K4 code: <the paths that fail K3>` | class `null`, REASONING_REQUIRED |
| owner-merges | A path matches a kind's glob | `owner-merges <kind>: <matching paths>` | merge `owner`, DECISION_REQUIRED |
| free-writers | The task is runnable at position `k` and `k` is above the number of `free` rows | `free-writers: <free> free, runnable <k>` | DECISION_REQUIRED |
| release-gate | The `release-gate` policy value names the task's `#N` | `release-gate: #N` | note `the release waits for it` |

`parallelWith` is pairwise disjointness. It says nothing about when either task may start: #267 is parallel with #266
although #266 waits for B4.

A task is **runnable** when it has a contour, an empty `after` and no lock. Only runnable tasks are counted, in queue
order.

A task with no path set gets no S or K3/K4 rule and no contour. K1 and K2 still apply, because they do not read paths.

Coverage outside the named twins:

- S3 is covered by `rules/s1-overlap-neg`, where the two disjoint tasks list each other in `parallelWith`.
- S6 is covered by `rules/s6-wait-merged-pos`. Its predecessors, a queued task and an open PR, keep their edges. In
  `-neg` both are gone, as they would be once merged, and no edge remains.
- release-gate is covered by `rules/release-gate-pos`, where the policy names the task's `#N`: the note is added and no
  DECISION_REQUIRED is raised. In `-neg` it names another number, and no note is added. The corpus has no
  `release-gate` row.

## `--json` shape

Key order is part of the contract, because a fixture is compared as a whole string.

```json
{
  "vocabulary": ["the 22 capabilities, in the order the brief lists them"],
  "rows": [
    {
      "task": "#249",
      "paths": { "write": ["sorted path set"], "immutable": ["as built"] },
      "effort": "medium",
      "verification": ["capabilities, in vocabulary order"],
      "class": "R2",
      "why": ["entries, as above"],
      "contour": {
        "after": ["tasks in queue order, then PR #N"],
        "parallelWith": ["tasks in queue order"],
        "worktree": "../mc-249-init-harness",
        "locks": ["no merge until PR #N", "tree held by window X"],
        "executor": "ladder",
        "merge": "auto",
        "capabilities": ["capabilities, in vocabulary order"],
        "notes": ["the release waits for it"]
      },
      "unresolved": [{ "level": "REASONING_REQUIRED", "reason": "…", "source": "…" }]
    }
  ],
  "notChecked": ["new-write-path"]
}
```

- `effort` is `null` when the build mode gives none. `class` is `"R2"`, `"R1.5"`, `"R1"` or `null`.
- `executor` is `"ladder"` when the effort is not null, otherwise `"direct"`. It stays `"direct"` for a K4 row.
- `merge` is `"owner"` when an owner-merges entry fired, otherwise `"auto"`.
- `worktree` is the brief's `Worktree:` path, otherwise `../mc-<id>`.
- **No contour** (no path set) is represented as an empty contour object, not as `null`: `after`, `parallelWith`,
  `locks`, `capabilities` and `notes` are `[]`, and `worktree`, `executor` and `merge` are `null`. The vocabulary
  witness reads `contour.capabilities` on every row.
- `unresolved` is ordered: the classification entry, then owner-merges, then free-writers.

| level | reason | source |
|---|---|---|
| `REASONING_REQUIRED` | `no Effort, no witness, writes code: R1 or R1.5` | `K4` |
| `REASONING_REQUIRED` | `no paths` | the task's file name |
| `REASONING_REQUIRED` | the build mode's refusal | `build mode` |
| `DECISION_REQUIRED` | `owner merges (<kind>)` | `owner-merges.md` |
| `DECISION_REQUIRED` | `open a window` | `open a window` |

The default output is the Markdown table: the header `| Task | Verification | Class | Why | Contour | unresolved |`,
the line `|---|---|---|---|---|---|`, one line per task, and then one `not checked: <kind>` line per `notChecked` entry.

## The corpus `day-2026-09-27` against the day

The snapshot is `files.txt` at 9513121, windows A and B `free`, and PR #265 (`chore: version packages`) open with
`runsAwaitingApproval: true`. The issues' `Paths:` are reconstructed from the frozen matrix. The briefs are the approved
texts, with `Worktree:` rewritten as a relative path.

| Row | Shredder (expected.json) | What the day did | Match |
|---|---|---|---|
| 01 #263 | K4, no class, REASONING "R1 or R1.5". Parallel with everything except B4. Runnable 1 of 2 | Ran directly in parallel with #249's brief (PR #264) | Contour matches. Class differs: the day ran it as R1.5 with witnesses and mutations, and the issue declares none |
| 02 #249 | R2 ladder, no predecessor. Runnable 2 of 2 | Ladder in window B (PR #270) | Matches |
| 03 #267 | R2 ladder, S1 after #249 on `src/model/write.ts`, parallel with B4 | Started after PR #270 merged, in parallel with B4 (PR #272) | Matches |
| 04 B4 | R2 ladder, S1 after #263 on `docs/cli.md`, S2 after #249, parallel with #267 | Started after PR #270 merged (PR #273) | Matches. The edge to #263 was never exercised: PR #264 had already merged |
| 05 XS lint-policy | K4, no class. S1 after #249 and after #267 on `src/model/write.ts`. Parallel with B4 | Ran after B4's review, not when PR #272 merged (PR #274) | Order matches. Class differs (R1.5 in the day). The later start came from a busy writer, and v0 now reads free writers |
| 06 #266 | R2 ladder, S2 after #249 and after B4 | Ran after the release, on the owner's order (PR #276) | Edges match. The wait for the release is not produced: the release-gate row names the tasks the release waits for, not the tasks that wait for the release |
| 07 CONTRIBUTING | K3 R1 direct. Runnable 3 of 2 free, so DECISION "open a window" | Not in the morning queue. Ran later, in parallel with #266 (PR #275) | No decision of the day to compare with. The window decision is an artifact of placing it in the morning queue |

Against the PR file lists, every file two of the day's PRs both changed is covered by an edge: `docs/cli.md` (B4 → #263),
`src/model/write.ts` (#267 → #249, XS → #249 and #267), and `contract/surface.json`, `src/program.ts`, `src/ui/lore.ts`
and the `cli-help` fixtures (B4 → #249, #266 → #249 and B4). No edge sits where the PRs did not overlap, apart from the
unexercised B4 → #263.

The snapshot itself never existed as one moment. PR #265 was opened at 08:48, three minutes after PR #264 (#263)
merged. So #263 queued and #265 open were never true together. Its `runsAwaitingApproval: true` locks nothing, so the
rows would be the same without it. Its `files` are the list at merge time.
