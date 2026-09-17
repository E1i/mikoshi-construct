---
layout: home
hero:
  name: mikoshi-construct
  text: A repository that already knows how it is built
  tagline: Architecture policy, an API contract, a quality harness and agent instructions — materialized into a repository in one command, then kept honest by a tool that says "unknown" when it cannot prove otherwise.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: The development cycle
      link: /guide/the-cycle
    - theme: alt
      text: CLI reference
      link: /cli
features:
  - title: One command, a working baseline
    details: An empty directory or a repository with ten years of history. Policy, harness, contract and agent instructions land; nothing you wrote is overwritten, and there is no --force.
  - title: The harness decides, not the agent
    details: Every implementation runs at the lowest reasoning class that can carry it, and a separate verifier — never the implementer — runs the quality gate and reports whether a test was weakened.
  - title: Discovery instead of guessing
    details: The CLI reports facts only. Everything that needs judgement is a marked block the coding agent fills by reading the code, with provenance recorded in the manifest.
  - title: Claims graded, never assumed
    details: doctor reports an enforcement level from L0 to L3 with the evidence it read, and answers "unknown" where proving a thing would mean running it.
  - title: Upgrades you can read first
    details: construct sync replays today's templates against the record the manifest cut at init, classifies every path, and writes only what it can prove the construct owns.
  - title: A record that is never crossed out
    details: construct.json is the protocol of everything the construct has written here. No run rewrites another run's lines, and every replacement is printed rather than performed quietly.
