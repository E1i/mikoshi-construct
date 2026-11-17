---
'mikoshi-construct': patch
---

The board's bus panel moves. EVENT FLOW is a strip that slides left by the minutes passed since the last refresh, with the newest bar entering highlighted on the right, and fills its cell's height. TOP EVENTS rows carry a share bar, sit at their rank and slide to a new one; a share that rose flashes green, and a family entering or leaving the top four fades. The five bus cells share one height, with TOP EVENTS and RECENT ACTIVITY centred. Every live status dot (bus pulse, node health, session state, crawler state) pulses; red and down states hold still, and all motion stops under `prefers-reduced-motion`. The workers row reads BUS WORKERS and names the workers whose heartbeat went silent, and the runner terminal uses a thin scrollbar.
