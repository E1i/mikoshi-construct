Open the fixture's test page, a path under /covered/ of the local server the run gives you, with the browser
lab's hands, in a playwright-cli session of your own (`-s=<object>` on every hands command), and click Go. Give
every lab command below one `--profile <dir>` of your own, so the click survives into step 5:

1. `hands … -- open -s=<object> <page>`
2. `hands … -- snapshot -s=<object>`, and take the ref of the button named Go from that snapshot.
3. `hands … -- click -s=<object> <ref>`
4. `hands … -- close -s=<object>`

hands carries no console of the content script. The click is kept in the extension's storage, and the content
script says its line on the next load of the page, so read it with the lab's `page` after hands is closed:

5. `page <page> --prefix daemon-fixture: --wait html[data-daemon] …`, and save its stdout as console.json.
