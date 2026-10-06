---
name: browser-lab
description: Bring up a real browser lab to observe a browser extension, a page or a UI whose result cannot be read from code, with scripts/construct/browser-lab.mjs.
user-invocable: true
argument-hint: <command> [extension directory or page url]
---

Use this when the result of a task lives in a browser: an extension, a page whose behaviour must be seen, a UI.
Run it from the repository root. It writes nothing in the repository and nothing in `package.json`;
`playwright-core` comes through `npx`, pinned.

Every command prints one JSON object. Optional permissions are granted in a copy of the manifest in a temporary
directory, so no permission prompt appears.

## Commands

```bash
node scripts/construct/browser-lab.mjs info --extension <dir>
node scripts/construct/browser-lab.mjs sw-eval <expression> --extension <dir>
node scripts/construct/browser-lab.mjs storage [area] --extension <dir>
node scripts/construct/browser-lab.mjs logs --extension <dir> --eval <expr> --for <ms>
node scripts/construct/browser-lab.mjs network --extension <dir> --page <url> --for <ms>
node scripts/construct/browser-lab.mjs popup --extension <dir>
node scripts/construct/browser-lab.mjs options --extension <dir>
node scripts/construct/browser-lab.mjs page <url> --extension <dir> --wait <selector>
node scripts/construct/browser-lab.mjs info --extension <dir> --profile <dir>
```

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
when it is missing, installs it itself with `npx playwright-core@<pinned version> install chromium`, saying so in one
line on stderr. On any other 127, stop and tell the person the command that failed.

## What stays with a person

Say it as a stop, not as a workaround:

- Installing from the Chrome Web Store, and the browser's confirmation dialogs.
- The permission prompts raised at run time.
- Signing in to accounts: signing in is theirs.
- The real popup window and side panel; the lab opens their pages as tabs.
