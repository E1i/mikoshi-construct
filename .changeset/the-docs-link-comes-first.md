---
"mikoshi-construct": patch
---

**The documentation link comes first, where a reader on npm actually sees it.**

The link to the site existed but sat below the install snippet and the version note, which on the npm
package page is under the fold. It is now the line directly beneath the description, with the four
destinations worth naming: the site, getting started, the development cycle and the CLI reference.

A test keeps it that way and keeps it true: every `e1i.github.io` link in the README must resolve to a
page this repository builds, and the documentation must be named before the install snippet. The
README travels to npm, where nothing checks it and a dead link stays dead until the next release.
