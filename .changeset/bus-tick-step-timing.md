---
'mikoshi-construct': patch
---

Every bus tick now writes one line with the duration of each of its steps: NetWatch.poll, intake, reduce, WindowRequests, second reduce, deriveQueues, setStepStatuses, StalledSessions and board. The bus database gains an index on events by pull request and head, so the merge and update candidates and the last status set on a head no longer walk every event of their type; on a copy of the bus snapshot, deriveQueues drops from about a minute to about a second and derives the same queues. The decisions in force are read once per queue derivation instead of once per lookup.
