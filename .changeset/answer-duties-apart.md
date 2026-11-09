---
'mikoshi-construct': patch
---

The answer node keeps each of its duties in its own file under `scripts/nodes/answer/duties/`: choosing the source (`source.ts`), publishing a tree with no pull request and the empty or dirty round (`publishing.ts`), the owner's or the stale question and the window's shard decision (`stale-question.ts`), the outcomes it records (`outcomes.ts`), the prompt with its CI log (`prompt.ts`), reading the card tree (`tree.ts`) and running the client (`client.ts`). `answer-executor.ts` now composes those four executor duties and runs the round; `answerer.ts` runs the session and owns the window gate rule it hands to the prompt. Behaviour, events and prompts are unchanged. The `answer-duties` concept's owner exists now: a folder owner is read at its `index.ts`, and the factory's `answer-duties` overlaps fall from 42 to 1 — `liveSessionIn` stays in `answerer.ts`, where `liveness-sites.known.json` records it for the `live-session` concept.
