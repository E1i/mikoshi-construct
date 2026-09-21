---
"mikoshi-construct": minor
---

A construct claim is written only where its evidence holds on the tree init just wrote

`init` used to write facts it never evaluated. On a repository whose owner had written their own
`quality` script, the `harness-steps` claim was grounded in needles looking for the construct's
spelling of the harness steps — false at the moment they were written, and reported by `doctor` as
`unsupported` from the first run. That is a finding about what the preset shipped dressed as a
finding about the repository, which is the defect `hook` was removed for.

Now a construct-authored claim is made only when every fact it declares holds on the tree, the facts
nothing else stands on are not written, and `init` names each withheld claim with the evidence that
failed. A claim already in the record is kept whatever its state, so drift still reads `unsupported`
instead of disappearing; a claim whose evidence is merely unknown is still written, because not
having looked is not evidence of absence.

**On an adopted repository this withdraws four claims, not one.** A tree already carrying its own
`ci.yml` and `security.yml` keeps only the claims standing on files the construct wrote. The report
is shorter than it was — not because less is checked, but because less of it was pretending, which
is the sentence 0.5.0 shipped under and now covers a larger set. Decision 0020 records what the
construct stops asserting, that discovery is what may legitimately claim over the owner's own files,
and the asymmetry this accepts: a withheld security claim and an absent security practice both read
as silence.
