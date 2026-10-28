---
'mikoshi-construct': minor
---

attach: carries `scripts/construct/daemon.workflow`, `scripts/construct/daemon-run.mjs` and the `daemon` skill, which run an adapter's objects in a real browser lab — a fresh agent per object, at most two at once unless `limit` says otherwise, each on a `--profile-from` copy of the base profile — and leave `.construct/daemon/<run>/<object>/evidence.json` per object; an object whose prepare fails is recorded unobserved and starts no agent. `detach` removes a `.construct/daemon` attach did not find and leaves one that was there; `cost --json` gains a `daemon` key, present when `.construct/daemon` holds evidence, listing each object's run, object, verdict, agent label and the tokens of that agent's transcript (`null` when no transcript carries the label); the text report does not print it.
