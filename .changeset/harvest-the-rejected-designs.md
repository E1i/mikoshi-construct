---
"mikoshi-construct": patch
---

Ten `StructuredOutput` calls the runtime refused are frozen as fixtures, harvested from two architect
entries that died in the Design phase of one `/implement` run on a repository this construct had
materialized: two tasks entered Design, and neither returned a design or a line of code. The
journals of that run live under `~/.claude/projects/` and go away with the first cleanup of that
directory, so this record could not have been made twice.

They were harvested before anything was fixed, because the fix that seemed obvious is not the one the
record supports. Seven of the ten calls never reached schema validation at all: the runtime could
not read the input as JSON and said so, naming sizes from 3436 to 10 293 bytes. The other three
arrived as an object with no properties. A bound declared on the schema is a limit the validator
applies *after* an input parses, so for seven of these ten it would have changed nothing — and both
agents had already
shortened their answer twice over and been refused each time, one of them at 3436 bytes. Size alone
does not separate a call that works from one that does not.

Every recorded completion stopped with `tool_use` rather than `max_tokens`, so the model considered
each of these calls finished. All ten ran at `xhigh`, the effort the ladder gives Design.

The accompanying note draws the line between what the runtime reported and what the logger kept: the
journal stores the first 2048 characters of a tool input, so the stored payloads are prefixes that are
themselves cut off, and the bytes at which these answers actually became invalid are gone. A test that
proved one of these prefixes fails to parse would have proved something about the logger. The
vocabulary of the private project's product surface is replaced the way the frozen manifests were,
the arity and shape of each list kept, and the two task briefs are not stored at all because they
named a private repository and the accounts that own it.
