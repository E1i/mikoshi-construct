---
"mikoshi-construct": patch
---

The browser lab's `page` takes `--for <ms>`: it stays on the page that long after load and only then reads the title, the text and the screenshot, and every line of `console` carries its time in `at`, with the window in `listenedMs`. With `--route` the window defaults to 15 seconds, so a check a page repeats after load is reported beside the first one instead of the first one standing as the verdict; a `page` with no `--route` still reads at load. A `page --route` run now takes 15 seconds longer unless `--for` says otherwise.
