---
"mikoshi-construct": patch
---

release: a publish that awaits approval reads as pending, not as absent. The Release run publishes with `npm stage publish` (npm 11.15.0 or newer, which the job now installs) instead of `changeset publish`. It uploads `{version, stageId}` as the `release-stage` artifact, and `changeset tag` still writes the git tags and GitHub releases. Release verification downloads that record. If the version is absent from the registry and a stage record exists for it, the run prints the stage id with a notice to re-run this run after approval, then cancels itself: it ends grey, and Published smoke stays skipped. If the cancellation does not take effect, the run ends red, never green. If the version is absent with no stage record, it still fails with the same message as before.
