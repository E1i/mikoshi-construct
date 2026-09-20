---
"mikoshi-construct": patch
---

The model now carries two claims it was missing. `harness-steps` says that the harness command runs
lint, typecheck and tests rather than merely existing as a script, grounded in the script body
`package.json` actually holds — `pnpm lint`, `pnpm typecheck`, `pnpm test`, as the harness template
writes them — never a bare word like `test`, which matches half a manifest by accident. `lint-policy`
says the declared lint policy is itself checked by a test, and exists only where the preset's sample
group was materialized, because only there did `init` write the test it stands on. A claim with no
materialized file behind it is worse than no claim at all, so the condition is part of the claim, not
a caveat beside it.

`doctor` still computes its own verdicts; nothing under `src/commands/doctor` changed and
`doctor --json` is byte-identical. What changed is that every one of its check ids now has a recorded
decision about where its verdict belongs, asserted over an enumeration derived from `CHECK_IDS` rather
than from a list retyped in the test. The mapping is not one-to-one — `ci` maps onto a claim that
already existed, `construct-tests` is provenance, `hook` and `red-gate` are dropped with their reasons
— and that is the hazard the test closes: a check with no claim of its own is indistinguishable from a
forgotten one unless somebody wrote the decision down. A new member of `CHECK_IDS` with no entry now
fails the suite by name.

`architecture/model.md` gains the two rules behind that. Why a `Claim` carries exactly one enforcement,
so that CI and a local hook are two claims about two mechanisms and not one claim read as a duplicate;
and the test for where a verdict belongs — knowledge if it can become false without anything `init`
wrote changing, provenance if it becomes false only when what `init` installed has changed, with
`harness-steps` and `construct-tests` worked through as the two sides.
