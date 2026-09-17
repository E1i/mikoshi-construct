---
"mikoshi-construct": minor
---

The replay engine for `construct sync`: given a repository and its manifest, it renders the preset's current groups through the same materializer `init` uses and classifies every path against what is recorded and what is present. It writes nothing. Replaying with a second, parallel renderer would have drifted from the first one invisibly, because both would have been ours.

It renders with the variables the manifest recorded, substituting exactly one: `constructVersion` comes from the running CLI, because a replay that stamped files with the version being replaced would write the old number into the very field the version gap is read from. Everything else stays as recorded — re-detecting the environment would rewrite files like `.nvmrc` that nobody asked to change. A variable the manifest does not carry stops the replay naming every missing one and how to supply it, so a repository materialized by an older version is never left permanently unsyncable.

This repository's own `construct.json`, exactly as construct 0.1.0 wrote it, is frozen as a fixture — a real record from a real older version rather than a constructed one.

Alongside it, a ladder correction the first `high` run after the previous change exposed: a design step that *completed* was recorded nowhere, so a run's attempts list and its token accounting disagreed about how many agents had worked. A completed design is now an attempt like any other.
