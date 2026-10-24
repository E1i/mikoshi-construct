---
"mikoshi-construct": minor
---

attach accepts a repository that carries its own construct, such as a clone of a constructed repository at a tag: the carriers its construct already tracks stay its own and are neither written nor recorded, where before attach refused with "already carries a construct". attach now deploys the factory beside the repository, the directory `~/.construct/<repository id>/` with an empty bus, so the factory started there keeps its bus apart from the machine bus, and records it as `factoryBeside` in `.construct/attach.json`. detach removes that directory and the Engram `construct atlas` wrote for the repository under `~/.construct/engram/`, and nothing else outside the repository; it refuses, removing nothing, while a factory process beside the repository is alive or a keep-alive names its directory.
