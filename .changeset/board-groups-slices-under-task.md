---
'mikoshi-construct': patch
---

cli: the board groups the slices of one task under a single task line, `task #N · slices merged m of n`, in `construct board` and on the page. It gathers slices from different lanes. On the page each task is a group that starts collapsed and remembers whether it is open across reloads. An owner wait on the task or on any of its slices appears on the task line, so collapsing the group never hides it. The board's own text is all English and counts read `1 card` / `N cards` and `1 task` / `N tasks`; the slice mark reads `◧ k/n · of #N`. On the page the refresh shows a countdown that survives a reload, the load figure counts up, the lag item in "waits for you" is a button that re-reads the board at once, and the header shows the interface version, the package version plus the short build sha stamped at build time.
