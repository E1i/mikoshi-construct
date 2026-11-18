---
'mikoshi-construct': patch
---

`construct intake --draft` admits a draft into the bus all or nothing: every `card.admitted` and window wait of the draft is written in one transaction, after the creates-owner check has passed for every card of it. A refusal that ends "Nothing was admitted." — a later card creating a file its touches do not reach the owner of, or naming a release the bus has not opened — now leaves no card of that draft admitted, where before the cards ahead of it stayed in the bus.
