---
"mikoshi-construct": minor
---

`construct sync` arrives in its reporting form: it classifies every path of a materialized repository against today's templates and prints what it found. It writes nothing — the writer is a separate change, so a person can see what would happen before anything happens.

Each class is printed beside what it means, because the words are borrowed from merge tooling and read as alarm without them. Nine `conflict` entries on a mature repository are not nine problems; they are nine files the owner owns, which the report now says on the same line. Classes with no paths are left out entirely rather than printed as zeroes, so an empty class is never read as a finding. Where an append-block target would be written, the report states that the block is replaced whole and that edits between the delimiters do not survive while discovery bodies are carried over — printed from the classification itself rather than restated, so the two cannot drift apart.

The report opens with the version that materialized the repository against the version reading it, and closes on what would happen. Exit code 0 when there is nothing to add or update, and a distinct code when there is; conflicts, removals and orphans never change the code by themselves, because they are not work the tool can do.
