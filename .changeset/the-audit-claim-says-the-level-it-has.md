---
"mikoshi-construct": patch
---

The model every repository gets from `init` claimed `vulnerable-dependencies-are-visible` at **L3**,
and the job behind it ships with `continue-on-error: true` in `templates/base`. A job with that flag
is marked successful even when its step fails, so the check is green whether or not a vulnerability
was found. The claim asserted a level the mechanism cannot reach, in the release that shipped the
model, in every repository materialized by it.

The level is now `L0` and the mechanism says why: the audit runs on a schedule and on pull requests,
reports into the log, and can never fail a check, so nobody is obliged to act on it.

The scale reads `L3` as "CI that does not block a merge", which superficially fits — but that wording
presumes a check able to report a failure at all, and distinguishes `L3` from `L4` by whether the
failure blocks. A check that is green in both worlds carries no information and sits below the scale.

The mechanism was left as it is rather than made to fail. A dependency audit reads an external
advisory database, so making it block would fail on news rather than on the change, which is
presumably why the flag was set. Lowering the claim to the truth is the repair; raising the mechanism
is a separate question with its own costs.

This is rule 8 applied to the tool itself — the presence of a command is not the level at which it is
enforced — and the first case where a claim was `held` on facts that were all true while the
mechanism it named could not fail. `supportedBy` gives necessary conditions, never sufficient ones.
