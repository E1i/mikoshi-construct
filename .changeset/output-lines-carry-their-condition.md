---
"mikoshi-construct": minor
---

Three output lines stop claiming a case they are only true in

Found by taking a live adopted monorepo through `sync`, `sync --apply`, the harness, `init` and
`doctor`. The model was written and five claims recorded; the output made it read as though nothing
had happened.

`doctor` told an adopter that `lint-policy` stood on facts that all hold and that `construct init`
would record it. It never will. The claim comes with the preset's sample sources, and `init`
materializes those only into an empty directory — which the tree `doctor` inspects never is, because
it carries a `construct.json`. The `every-fact-holds` reading now splits: it keeps that name and that
promise only where a run in this repository really would write the claim, and reads `sources-omitted`
where it would not, saying so instead. `--json` carries the fourth value under `reading`.

`init` reported how many records it carried over and how many it added *after* the list of paths, so
a second run read as a full re-materialization until the last line. The count, and the variables this
run changed, now print before the list. What the run changed is reported before what it looked at.

`init`'s closing line named `pnpm install && pnpm run quality` whatever the run did. It now names
install and the harness where the run wrote a package manifest, the harness alone where it changed
other files, and nothing at all where it changed no file — which is what a third `init` on the same
tree does.

`init` chose the `AGENTS.md` and `CLAUDE.md` form from whether the file exists, when the question is
which form the construct wrote. By the second run the file always exists, so a second `init` replaced
the full document it had written itself with the short form meant for a repository that already had
one — on a real adopted monorepo that silently removed the baseline command list. The form now comes
from `variants` in `construct.json`, which records it, and `appendBlock` no longer counts the heading
inside its own block as a document heading it must demote. A second and a third `init` on a tree the
construct materialized from empty now leave both files exactly as the first run wrote them.
