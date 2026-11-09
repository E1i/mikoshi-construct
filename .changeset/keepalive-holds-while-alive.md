---
'mikoshi-construct': patch
---

The factory keep-alive no longer restarts `construct-factory` every 20 seconds while the factory is running. The launchd agent ran the starter, the starter found the bus processes running, left them alone and exited 0, and launchd started it again: thousands of launches a day, enough to raise the machine's load. The agent now runs `construct-factory --hold`, which starts what is missing and then stays up while the supervisor of its bus runs, checking every 20 seconds; once the supervisor is gone it exits non-zero and launchd starts the factory again. Run by hand, `construct-factory` still starts the factory and returns. An agent installed by an older version is rewritten the next time `construct-factory` runs in its repository.
