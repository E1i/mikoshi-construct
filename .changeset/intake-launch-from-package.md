---
'mikoshi-construct': minor
---

New bin `construct-intake`: `construct intake` with every admit, slice and move recorded on your repository's bus, so the factory `construct-factory` started launches the card. Beside that bus `construct intake` no longer parks a card the factory cannot see: it writes nothing, names `construct-intake` and exits 1. From the installed package the factory's launch now cuts the card's tree and opens its pull request through the package's own built files, not through scripts of the mikoshi-construct checkout.
