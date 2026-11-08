---
'mikoshi-construct': patch
---

Every bus event type now declares its payload keys in one catalogue, `EVENT_PAYLOADS` in `scripts/core/events.ts`. `contract/factory.json` reads each event from that catalogue, so all 109 are complete and none is written outside it, and the generator refuses a writer that writes a payload key the catalogue does not declare.
