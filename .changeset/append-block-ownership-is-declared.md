---
"mikoshi-construct": patch
---

Ownership of an append-block target is declared by its delimiters rather than inferred from a recorded hash. Replaying a manifest written by `init` classified `AGENTS.md` and `CLAUDE.md` as `conflict` — the two files carrying the construct's own markers — because the ordered comparison asked a recorded whole-file sha whether anything in the file had changed, and discovery filling the markers, which the construct asks the owner to do, made that answer false forever. `construct:begin` and `construct:end` are ownership stated outright in a file the owner reads and can delete, so for those targets the comparison now asks only whether the owned view is what the templates produce: equal is `keep`, different is `update`. A recorded file the owner stripped the delimiters from is `conflict` and never has the block put back.

`merge-json` is unchanged and still never written: `package.json` carries no mark of which keys are the construct's, so there is no declaration to outrank the record. A classification for a block that will be written now carries that the block is replaced whole and that edits inside the delimiters do not survive while discovery bodies are carried over, so a report and a writer state it from one source.
