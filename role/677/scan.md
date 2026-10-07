# Blind Design check, card #677

Head checked: 4fedc077100f3f881c9fdb0fdc78027785ad2f5d (matches). Line numbers are in the head's files (diff context for lore.ts, changeset).

| Design item | where in the diff (file:line) | holds / drift / blocker | why |
|---|---|---|---|
| 1. Files changed, nothing else | `git diff --stat`: the 10 files below | holds | src: detach/runtime, restore, index; attach/carriers, index, record; ui/lore; tests/detach, tests/attach; `.changeset/detach-removes-guest-runs.md` (minor). No contract/, architecture/, docs/ |
| 2a. `browserHeld?: string[]` on `AttachRecord` | src/commands/attach/record.ts:19 | holds | one added line, optional field; `ATTACH_RECORD_VERSION` not touched |
| 2b. `browserEntriesHeldAtAttach(root)` sorted names, `[]` when absent or not a directory | src/commands/attach/carriers.ts:54-60 | holds | `readdirSync(...).sort()`; the catch returns `[]` for absent and for non-directory |
| 2c. attach calls it beside `runtimeHeldAtAttach`, before any write, writes `browserHeld` | src/commands/attach/index.ts:149 (call), :184 (record) | holds | call sits right after `ledgerHeld`, before `writeExcludeBlock`; passed into the record literal |
| 3. `classifyRuntime`: `browserFree` takes every matching run; `guestRunsOnly` = browser directory, `ledgerHeld` array, `!browserFree`, `browserHeld` array of strings; a run goes only if its name is not in `browserHeld` | src/commands/detach/runtime.ts:62-65 (reader), :75-78 | holds | no clock, no mtime, no attachedAt. Record without `ledgerHeld` or without `browserHeld`: `guestRunsOnly` false, none removed. Name regex, directory, all-png and untracked filters kept on the same line |
| 3. `.construct/browser` removed only when `browserFree` | src/commands/detach/runtime.ts:83 (`browser: browserFree`) | holds | unchanged; held directory stays, `detachLeftBehind` path untouched; `notes.txt` is not a run so stays |
| 4. `takeOutGuardEntry` returns `bytesRestored`; byte-restore branch `entryCutOut:false, bytesRestored:true`; other branches `bytesRestored:false` | src/commands/detach/restore.ts:35, :38, :42 | holds | |
| 4. `runDetach` prints `detachOriginalRestored` when `bytesRestored`, `detachEntryRemoved` only when `entryCutOut`; non-restore path supplies `bytesRestored:false` | src/commands/detach/index.ts:115-117, :126-129 | holds | exactly one of the two prints; not a `-` line, not in `detached(n)` |
| 4. lore line in interface, `LORE`, `PLAIN_LORE` with the given text | src/ui/lore.ts:230, :607, :960 | holds | texts match the Design character for character |
| 5. changeset, minor, one `cli:` paragraph naming what detach removes and says, `browserHeld` with `recordVersion` 2, earlier-build records leave held browser as is | .changeset/detach-removes-guest-runs.md:1-5 | holds | |
| 6. one existing test moves (`writeRuntime(dir)` above `await attached(dir)`); only the `node:fs` import and `await attached(dir)` lines removed from existing tests | tests/detach.test.ts, tests/attach.test.ts (removed lines: the import line, `await attached(dir)`) | holds | the only two removed lines in tests/ |

## Not in the Design

Behaviour changes in detach or attach writes into another repository that the Design does not name: none found. `src/` changes are exactly the seven listed above; no deletion path other than the existing run removal gained a new trigger. Notes, not drift: `browserEntriesHeldAtAttach` is a second function of the same name in `detach/runtime.ts` (local, unexported) and in `attach/carriers.ts` (exported); the Design names only the attach one. A browser that is a symlink to a directory is read by `readdirSync` through the link (follows it), same as the existing detach listing.

## Touches check

Touched files: .changeset/detach-removes-guest-runs.md, src/commands/attach/{carriers,index,record}.ts, src/commands/detach/{index,restore,runtime}.ts, src/ui/lore.ts, tests/attach.test.ts, tests/detach.test.ts. All inside the brief's touches. Outside: none.
