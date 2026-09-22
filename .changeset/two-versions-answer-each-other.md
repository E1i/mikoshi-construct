---
"mikoshi-construct": patch
---

0.15.0 and 0.16.0 each carry a dated notice naming the other

The changelog asserts that 0.15.0 is a release. It is not: no tag, nothing on the registry. Under
[0021](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0021-a-record-of-the-past-is-not-edited.md)
the entry is not corrected — it records what was versioned, and that did happen — so a dated notice is
added beside it instead, and the entry is left as it was written.

**The notice is written in both directions, and the more important one is on 0.16.0.** A reader
arrives at the version they installed, not at the one that does not exist: someone on 0.16.0 sees an
entry naming a single pull request and has no way to learn that two more shipped inside it. So 0.16.0
says it carries what is listed under 0.15.0, and 0.15.0 says its changes went out as 0.16.0. This is
0021's own remedy for a stale record — a pointer from the old statement to the new one — applied to a
pair rather than to one file.

A notice is parsed out of the changelog rather than kept in a second list, and a test fails when one
points at a version that answers nothing back, so the pair cannot be half-written. The rendered
release-notes page carries both, because it is generated from the changelog.
