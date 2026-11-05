---
'mikoshi-construct': patch
---

Card and review worktrees are now reused: a closed card's clean tree parks in a small pool beside the card trees and the next card takes it, reset to its base with nothing of the card before it, instead of removing one tree and creating another. A stopped card's tree, a tree with a live session and a dirty tree never enter the pool. Installs hardlink from the shared pnpm store, the card tree home carries a Spotlight marker, and `scripts/window/session-load.ts` prints sys CPU, syspolicyd and fseventsd percent, and node per session as one reading.
