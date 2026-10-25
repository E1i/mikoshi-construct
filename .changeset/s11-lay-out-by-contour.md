---
'mikoshi-construct': patch
---

The factory scripts are laid out by contour: `scripts/{core,ports,policy,nodes/<name>,supervisor,window,intake,ladder,cli}/**` in place of `scripts/{bus,ghosts,shift,miko,decisions,shredder,lanes}/**`, in the repository and under `dist/scripts/**` in the package, with every file keeping its name. A factory entry runs as, for example, `node dist/scripts/core/reducer.js`; `construct-factory` runs `dist/scripts/supervisor/start.js`, `construct-intake` runs `dist/scripts/intake/intake.js`, and the launchd job is `scripts/supervisor/launchd/dev.mikoshi.bus.plist`.
