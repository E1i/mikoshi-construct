Open the fixture's test page, a path under /covered/ of the local server the run gives you, with the browser
lab's hands, in a playwright-cli session of your own (`-s=<object>` on every hands command):

1. `hands … -- open -s=<object> <page>`
2. `hands … -- snapshot -s=<object>`, and take the ref of the button named Go from that snapshot.
3. `hands … -- click -s=<object> <ref>`
4. `hands … -- console -s=<object>` until a `daemon-fixture:` line appears, a few tries at most; save the
   last one's stdout as console.json.
5. `hands … -- close -s=<object>`
