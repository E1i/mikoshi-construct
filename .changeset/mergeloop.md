---
"mikoshi-construct": patch
---

A merge task on a pull request that cannot merge now parks instead of spinning through lease → `policy.denied` → release every few seconds: on a dirty pull request it is denied once and waits for a new head, and under an open owner question it is denied once and is requeued when the question closes. The bus's `mikoshi` status check is written only when the step or state on a head changes, so a repeated lease no longer posts the same status again.
