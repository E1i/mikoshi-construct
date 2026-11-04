---
"mikoshi-construct": patch
---

The sandbox list in `scripts/ci/sandbox-failing.jsonl` again holds what the session sandbox refuses on main, so a card that touches a selector file is no longer stopped by the pre-push run on paths it does not own. The four suites that install the packed package are listed under a new refusal kind for the npm registry's 403, which the liveness trace now reads in whichever words the session's proxy uses, one run-root test moves to a new refusal kind for `mktemp` under `$TMPDIR`, and the two run-root entries that now pass are gone.
