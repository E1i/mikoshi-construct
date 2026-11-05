---
name: browser-lab
description: Bring up a real browser lab to observe a browser extension, a page or a UI whose result cannot be read from code, with scripts/construct/browser-lab.mjs.
user-invocable: true
argument-hint: <command> [extension directory or page url]
---

Use this when the result of a task lives in a browser: an extension, a page whose behaviour must be seen, a UI.
The script runs from `~/.construct/browser-lab/bin/browser-lab.mjs`, outside the repository, where the bus installs it
when it prepares a card tree. Run the bare command from the repository root, with no `cd`, `env` prefix or `&&`, and
write the path out absolute where the commands below say `<home>`, with no `~` or `$HOME`:
`sandbox.excludedCommands` matches only the bare command line, and anything else silently puts Chromium into the
sandbox, where it cannot start. The copy at `scripts/construct/browser-lab.mjs` in a repository, or any other copy
in it, is not excluded and stays in the sandbox. The lab writes nothing in the repository and nothing in
`package.json`; `playwright-core` comes from the lab's own cache, pinned.

Every command prints one JSON object. Optional permissions are granted in a copy of the manifest in a temporary
directory, so no permission prompt appears.

## Commands

```bash
node <home>/.construct/browser-lab/bin/browser-lab.mjs info --extension <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs sw-eval <expression> --extension <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs storage [area] --extension <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs logs --extension <dir> --eval <expr> --for <ms>
node <home>/.construct/browser-lab/bin/browser-lab.mjs network --extension <dir> --page <url> --for <ms>
node <home>/.construct/browser-lab/bin/browser-lab.mjs popup --extension <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs options --extension <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs page <url> --extension <dir> --wait <selector>
node <home>/.construct/browser-lab/bin/browser-lab.mjs info --extension <dir> --profile <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs page <url> --extension <dir> --prefix <text> --route <url-glob> <file> --shot <file>
node <home>/.construct/browser-lab/bin/browser-lab.mjs page <url> --extension <dir> --profile-from <dir>
node <home>/.construct/browser-lab/bin/browser-lab.mjs hands --extension <dir> --profile <dir> -- open <url>
node <home>/.construct/browser-lab/bin/browser-lab.mjs hands --extension <dir> --profile <dir> -- close
node <home>/.construct/browser-lab/bin/browser-lab.mjs page <url> --viewport <w[xh]> --color-scheme <light|dark> --press <keys>
node <home>/.construct/browser-lab/bin/browser-lab.mjs hands --profile <dir> -- open <url>
```

`page` prints `console`: every message of every level from the page and from the content-script world of the
extension, each with its `world` (`page` or `content-script`); `--prefix <text>` keeps the messages whose text starts
with it. `--route <url-glob> <file>` (repeatable) answers the page requests matching the glob with the file; requests
of the service worker are not routed, they belong to the adapter. `--shot <file>` writes a screenshot.

`--viewport <w[xh]>` opens the page at that size in pixels, height 800 when only the width is given. `--color-scheme
<light|dark>` sets `prefers-color-scheme`. `--press <keys>` presses each space-separated key or chord in turn after the
load and `--wait` (`--press 'Tab Enter Control+K'`); `--for <ms>` gives the page time to answer. The output repeats what
was asked. These three belong to `page`, with or without `--extension`.

`--profile-from <dir>` runs on a fresh copy of a base profile and deletes the copy at the end, so several runs can go
in parallel; an extension whose manifest has no `key` gets another id in the copy.

`hands` runs `@playwright/cli` (pinned) on the `--profile <dir>` given, with the lab copy of the extension when
`--extension <dir>` is given and on a plain site without it; its own
arguments go after `--`, and `snapshot` with element refs, `click` and `fill` come from it. It runs its own bundled
Playwright, so a second Chromium build is installed beside the lab's. The session stays open between calls: end it
with `hands … -- close` before any other command uses the same profile.

The lab takes both tools only from its own npm cache under the construct directory in the home directory, filled from
the public registry whatever the repository's `.npmrc` says; never from the repository, `npx` or `PATH`. A tool
missing there ends in 127, and the line names the command that fills it.

Add `--headed` to any of them to watch the browser. `page` also runs without `--extension`; with it, the output says
whether a content script of the extension ran in the page.

`network` lists the requests the extension's service worker sent, with the status each one got or the error it
failed with, while the lab opens `--page` (and runs `--eval` in the worker) in the same browser and listens for
`--for` milliseconds. Use it to see what the worker fetches when a page triggers it.

`--profile <dir>` runs the browser with that directory as its profile and keeps it after the run, so a login done by
hand once (`--headed --profile <dir>`) and the extension's storage survive into later runs; the extension copy stays at
one path inside the profile, so its id does not change. The login is done by hand once and is never scripted. Without
`--profile` the profile is temporary and deleted at the end.

## Exit codes

- 0 — observed.
- 1 — the page saw no content script of the extension.
- 127 — could not observe, with the reason on stderr.

At start the lab checks that the Chromium build its pinned `playwright-core` needs is in the playwright cache and,
when it is missing, installs it itself with the cached `playwright-core`, saying so in one line on stderr. A 127 that names the sandbox means the command was not bare or not the absolute path: run it as above. If the bare command gets the
same 127, `sandbox.excludedCommands` has no entry for it in this session; stop and tell the person. On any other 127,
stop and tell the person the command that failed.

## What stays with a person

Say it as a stop, not as a workaround:

- Installing from the Chrome Web Store, and the browser's confirmation dialogs.
- The permission prompts raised at run time.
- Signing in to accounts: signing in is theirs.
- The real popup window and side panel; the lab opens their pages as tabs.
