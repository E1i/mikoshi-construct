---
"mikoshi-construct": patch
---

The implement skill says to start the ladder only from a turn whose only user message is the `/implement` itself. The Workflow runtime relays the message that triggered the run to the ladder's agents as a request that outranks the computed brief, so a message sent in the same turn becomes the implementer's task. The ladder cannot check this, and the skill says that the rule holds by discipline alone.
