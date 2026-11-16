---
'mikoshi-construct': patch
---

When the supervisor stops an answer or launch session at its Eddies spend limit, it first saves the session's tree: it commits the uncommitted change on the card's branch (a tree that is mid-merge is left as it is, and so are the gitignored report and answer handoff). The stop is still a stop. The next answer round of that card reads the spend stop from the Eddies journal of the tree and starts a fresh session with the answer handoff and the diff in its prompt; it never resumes the overspent session. A launch session that ended on the spend stop continues in a fresh session from the saved tree with its handoff, built by the bus if the session left none. It is not stopped, and nothing is pushed from it. A question in its report still goes to the owner.
