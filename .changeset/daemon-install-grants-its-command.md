---
'mikoshi-construct': patch
---

A daemon skill now declares the exact command it runs in its frontmatter (`daemon-command:`, with `<home>` for the home directory), and installing the daemon grants that command. `construct init`, `construct attach`, `construct attach --upgrade` and `construct sync --apply` write it into both `permissions.allow` and `sandbox.excludedCommands` of the untracked `.claude/settings.local.json`, never into the tracked `.claude/settings.json`, and `construct detach` removes what attach added. The browser lab's command is no longer hard-coded: it comes from the browser-lab skill, so a window in `dontAsk` mode can run `node <home>/.construct/browser-lab/bin/browser-lab.mjs` without a permission prompt.
