---
"mikoshi-construct": patch
---

`architecture/model.md` now states how ownership inside the repository model is determined:
`authoredBy` is the sole source of it. `init` may replace only entries authored by `construct`, and
entries with any other author are carried over unchanged.

The rule was already what the writer does, but it lived in the writer's implementation and in a
reviewer's head, which is L0. The next consumer that needs to know who owns an entry would have
derived it some other way — from what references it, from whether the preset still produces it, from
where it sits in the file — and the model would have had two answers to one question. The document
names the derivations that are not permitted, rather than only the one that is.

It also says plainly that nothing checks this mechanically: the rule is held by review. That is the
honest level for a sentence, and stating it is better than letting a reader assume a test stands
behind it.
