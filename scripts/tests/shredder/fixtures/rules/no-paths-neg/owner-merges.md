# Owner-merged kinds (data)

Rule of application: Eli merges a pull request if at least one file it changes matches at least one glob of a kind; an empty cell means the kind is not checked by paths. (`release` is matched by its title.)

| kind | paths (globs) | what it covers | example |
|---|---|---|---|
| release | — (matched by title: «chore: version packages») | version pull requests | — |
| own-instructions | `.claude/**`, `scripts/construct/**`, `templates/ai/claude/**` | the agent's own working instructions | — |
| ghosts | `scripts/ghosts/**` | the Ghost launcher | — |
