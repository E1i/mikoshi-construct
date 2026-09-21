---
"mikoshi-construct": patch
---

templates: The discovery protocol's hypothesis step now tells the run to regenerate a rendered model
where the repository has one, the way its composition step already says to run `composition:render`.
Writing `construct.model.json` and leaving the artifact rendered from it behind turns the next harness
run red for a reason nobody connects to the step that caused it.

Found by sweeping every gate over a generated artifact for all the writers of its source, after a gate
tested in both directions still shipped a release-blocking defect: both of its mutations had been
performed by one writer, and a second one — the version bot — wrote the source and called no renderer.
