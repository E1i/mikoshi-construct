---
"mikoshi-construct": patch
---

`architecture/epistemic-rules.md` now says that a rule's normative scope is fixed once written. New
scope takes a new number; an existing rule may gain a "see also" reference to it, never additional
scope of its own.

The header already promised stable numbering, and that promise is easy to misread as making the rules
safely extensible. It is not, and the two guarantees are different. Stable numbering protects what a
reference points at. This protects what it means: widening an existing rule would silently change what
every citation of it already asserted, across decision records and commit messages nobody is going
back to reread. A rule that stops applying is struck through in place for the same reason.

The open question about evidence of enforcement capability now carries the constraint concretely. If
it resolves towards being a repository fact it becomes a new rule, not an expansion of rule 8 — *a
command exists → the enforcement level* is rule 8, and *the enforcement level → the capability
demonstrated* would be the new one. Adjacent in meaning is the argument for two numbers rather than
against.
