---
"mikoshi-construct": minor
---

`construct sync --apply` writes. It writes the paths the construct can prove it owns — `add` and `update` where the strategy is `create` or `append-block` — and nothing else: no conflict, no removed path put back, no file the construct never wrote adopted, no merged `package.json`, and no deletion. There is no flag that overrides that, and none will be added.

A block target is spliced rather than replaced: the produced text between `construct:begin` and `construct:end` goes in between the markers the file already carries, every byte outside them stays where it was, and a filled `construct:discover` body is carried over. The writer deliberately does not reuse the append path `init` takes on first contact, whose second-`H1` demotion would make what is written differ from what was compared — and an apply that writes something other than what it compared reports the same path as pending forever. An apply followed by a plain sync now reports nothing to add or update, which is the proof the writer is honest.

Each written path is recorded in `construct.json` under `sync` with the sha of its owned view, when the run happened, the version that materialized the repository and the version that wrote. The branch `init` wrote is untouched, the record accumulates across runs, and when nothing was written the manifest is not touched at all. `doctor` still reports a rewritten file as modified: the baseline is what `init` recorded, and correcting it would erase the evidence of what `init` did.

Exit code 0 when every pending path was written, 2 when one was refused because no record can prove the construct owns it — every merge-json target, whose keys are reported for you to carry across — and 1 without a `construct.json`.

The `CLAUDE.md` a new repository receives no longer opens with an `H1`: it opens with `@AGENTS.md`, which imports the document that carries the project's title. Inside an existing repository's `CLAUDE.md` that heading was a second title, and sync writes the same block into both kinds of file.
