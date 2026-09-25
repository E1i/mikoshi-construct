# Upgrading a repository

`sync` is one step of four, and it is the only one that writes. A consumer repository moving onto a
new release runs them in this order:

```bash
npx mikoshi-construct@latest sync            # read the report; nothing is written, not even the manifest
npx mikoshi-construct@latest sync --apply    # write the paths the construct can prove it owns
pnpm run quality                             # your harness decides whether the result is good
npx mikoshi-construct@latest doctor          # baseline, harness, discovery, enforcement levels
```

Each step answers a different question, and none of them answers another's. `sync` says what changed
between the record and today's templates. `--apply` writes the subset it owns and records what it
wrote. **Your harness, not `sync`, decides whether the tree is still good** — the construct writes
what it can prove is its own, which is not the same as proving your project still builds. `doctor`
then reports the state of the baseline, the harness and the ten discovery markers, with the
enforcement level of each check.

**A repository newer than your CLI stops every command, and says so.** `construct.json` declares the
shape it was written in, and a binary that does not understand that shape reads nothing rather than
guessing at it:

```
ERROR: construct.json declares manifestVersion 5, and this binary understands 4. Nothing was read
and nothing was written: upgrade the CLI (npx mikoshi-construct@latest) and run this again.
```

Upgrading is exactly when this happens — a stale global install meeting a manifest a newer release
wrote. Nothing is written in that state, so an old CLI cannot damage a newer repository; take the
line at its word and upgrade the CLI.

**Discovery is not part of the loop, and a sync never erases it.** A construct block is replaced
whole, but the filled body of every `construct:discover:*` block inside it is carried across —
that is what `block-replaced-whole-discovery-bodies-carried-over` means in the report. Run
`/construct-discover` when `doctor` names a marker as missing, which happens when a release adds a
marker your repository has never filled, not because a sync ran.

**What the report leaves for you** is everything `--apply` refuses to touch:

| In the report | What to do |
|---|---|
| `conflict` | Nothing, unless you want to. The file diverged from what was recorded, and which version is right is your decision. Diff it against the template if you want to see what you are declining. |
| `merge-json` keys | Apply them by hand. `package.json` is compared key by key and never written — a new script or a moved dependency range is shown as a key so you can copy it. |
| `unknown` | Leave it. On a repository materialized before 0.3.0 nothing records which template variant wrote the construct block, so `sync` will not write it — now or later. Editing the block by hand is the way to take the new form. |
| `block-edited` | Nothing, unless you want to. The construct block differs from the block the last write recorded, so someone edited it; `sync` never overwrites it. |
| `record-vars-edited` | Put the value back. The block is what the last write recorded, but a value under `vars` in `construct.json` differs from the one it was written with. Restore the recorded value, or run `construct init` again to re-render with the new one. |
| `removed` | Nothing. A path you deleted stays deleted; `sync` never puts it back. |
| `orphaned` | Nothing is required. The construct wrote it once and no longer produces it; keeping it costs nothing and deleting it is your call. |

**`init` is not the upgrade command.** Before 0.3.0 it was actively dangerous: a second `init`
rewrote `construct.json` with only the files that run wrote, so every path the earlier run wrote and
this one skipped left the record. Measured on a scratch tree carrying 43 recorded paths, the next
`sync` read 4 `keep` and **39 `conflict`** — nothing in the tree had changed, only the knowledge of
who wrote it. That is fixed: the record is additive now, and a re-`init` carries forward every line
it did not write. It is still the wrong command for an upgrade, for the reason at the bottom of this
page — with the single exception above, where the repository has no model and nothing else writes
one.

**The version in `construct.json` does not move, and that is deliberate.** `construct` records the
version that materialized the repository and is frozen (ADR 0006); a `sync` adds a `sync` record
beside it with `fromVersion`, `toVersion`, `ranAt` and the hashes it wrote. So `doctor` keeps saying
*materialized by 0.1.0, read by 0.4.0* however many syncs run, which stays true. The number that
moves is the count of pending paths beside it, and it reaches zero when there is nothing left to
write.

## The one upgrade that needs `init`

A repository materialized before 0.5.0 carries no `construct.model.json`, and `sync` has never
written one — so the file stays absent however many syncs run. You do not have to go looking for
this: `doctor` reports it once and names what writes it.

```
Enforcement
  There is no construct.model.json here: nothing was read, so nothing is known about what this
  repository claims — which is not a reading that nothing is enforced.
  One is written by `construct init`, which is additive and overwrites nothing it does not own.
  Nothing forces you to have one.
```

So there is a fifth step, run once and only in that case:

```bash
npx mikoshi-construct@latest init            # only where doctor reports no construct.model.json
```

Two things make it safe, and both are worth knowing first. The record is additive, so the run
carries forward every line it did not write ([decision
0013](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0013-a-second-init-adds-to-the-record.md)).
And a construct claim is written **only where its evidence holds on the tree it is written for**
([decision
0020](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0020-a-claim-is-written-only-where-its-evidence-holds.md)),
so the run cannot invent enforcement your repository does not have: a claim whose facts do not match
is not written at all, and `init` names each one it withheld and the evidence that failed.

**Expect fewer claims than you may remember, not more.** Where the construct did not write the
file a claim stands on — your own `ci.yml`, your own `security.yml` — that claim is not made. On a tree
carrying both of those, four are withheld. The list is shorter **not because less is checked, but
because less of it was pretending**, which is the same reading 0.5.0 shipped under.

## Why `sync` and not a second `init`

A second `init` is additive since 0.3.0: it carries the record it finds forward instead of replacing
it, and prints what it carried over and every variable whose value changed ([decision
0013](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0013-a-second-init-adds-to-the-record.md)).
It is still the wrong tool for an upgrade: `init` writes what it writes, reports what it skipped and
stops, while `sync` compares the record against today's templates and tells you, path by path, what
would change and why it may or may not touch it. Use `init` to bring the construct to a repository,
and `sync` to move a repository that already has one — and `init` once more, on a repository that
predates `construct.model.json`, because `sync` has never written that file and never will.
