---
"mikoshi-construct": minor
---

templates: the acceptance build in `scripts/construct/check-acceptance.mjs` now refuses a brief whose Acceptance or Invariants items were not split where the author meant. An item that holds more than one `— witness:` marker is refused, because the build splits items only on `;` and such an item would be checked by its last witness alone. An item that begins with a command continuing the witness before it is refused too, because a `;` between two witness commands cut it off its own item. Each refusal names the item and says how to write it: end each item with `;`, and give each witness command its own item. Before this, such a brief built and its ladder ran on fewer items than the brief listed
