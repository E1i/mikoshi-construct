---
'mikoshi-construct': patch
---

Reading a card's witnesses now lives with the card. `witnessesOf` and `judgedFieldWitnessesOf` move from the intake admit command into `src/card/witness-fields.ts`, so the bus policy no longer imports the admit command to read a card's witnesses. Behaviour is unchanged.
