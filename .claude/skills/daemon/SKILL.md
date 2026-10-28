---
name: daemon
description: Run a daemon adapter over its objects — one fresh agent per object in a real browser lab, at most N at once — with scripts/construct/daemon.workflow, and read the evidence it leaves.
user-invocable: true
argument-hint: <.construct/daemon/<name>> [limit] [base profile]
---

Use this when an adapter in `.construct/daemon/<name>/adapter.json` names objects that each need to be seen in a
browser. Check the adapter first; a refused adapter starts nothing:

```bash
node scripts/construct/daemon.mjs check .construct/daemon/<name>
```

Then run the workflow with `scriptPath: scripts/construct/daemon.workflow` and these args:

- `adapter`: `.construct/daemon/<name>`.
- `limit`: how many objects run at once; 2 when it is not given.
- `baseProfile`: the browser profile every object runs on a fresh `--profile-from` copy of, so objects run in
  parallel without sharing state. Log in once into it with `browser-lab.mjs … --headed --profile <dir>`.
- `run`: only to continue a run id `daemon-run.mjs objects` printed; otherwise the run gets a new id.

The workflow only orders. Each step is a command of `scripts/construct/daemon-run.mjs`:

```bash
node scripts/construct/daemon-run.mjs objects <adapter> [--run <id>]
node scripts/construct/daemon-run.mjs prepare <adapter> <run> <object>
node scripts/construct/daemon-run.mjs verdict <adapter> <run> <object> --agent <label>
```

`objects` builds the extension and lists the objects, one JSON line each with an `id`. `prepare` copies the
extension to a lab copy and runs the adapter's `prepare` on it; an object whose prepare fails is recorded
unobserved and starts no agent. A fresh agent per object reads the adapter's `mechanic` prompt and observes
through `scripts/construct/browser-lab.mjs`, its hands through `browser-lab.mjs hands`. `verdict` runs the
adapter's `success` on the object's evidence directory.

## Evidence

Every object leaves `.construct/daemon/<run>/<object>/evidence.json`:

```text
{ "object": "…", "verdict": "holds | false | unobserved", "line": "the success command's line", "lab": ["…/lab-1.json"], "screenshot": "…/shot.png", "console": "…/console.json", "agent": "daemon:<run>:<object>" }
```

`agent` is the label of the object's agent; its transcript carries the tokens the object cost. Report the
verdicts as the evidence states them, and an unobserved object as unobserved, never as a pass.
