# The factory and its two modes

> The factory is in **beta** (our label) until 24 hours of autonomy are proven.

`construct-factory` starts the factory in the background over the repository's own bus
(`~/.construct/<repo-id>/`): the workers switched on in `bus/workers.json` and the supervisor that keeps
them running ([CLI reference](/cli#construct-factory)). A second run starts nothing twice.

| Mode | Workers | Who merges |
|---|---|---|
| WINDOW (default) | `review`, `launch`, `answer`, `witness` on; `merge` off | a human |
| GHOST PROTOCOL | every worker on | the merge worker, under a window shard for the term |

```bash
construct-factory --mode window
construct-factory --mode ghost-protocol [--hours <n>]
```

- GHOST PROTOCOL needs an unused owner word `ghost-protocol <n>h` written with `construct say`. Without it
  nothing is switched and the command prints the ready line ([CLI reference](/cli#modes)).
- At the end of the term the supervisor returns the factory to WINDOW by itself; `--mode window` returns
  sooner and revokes the shard.
- `--live <worker>` needs the owner word `allow-live <worker>`; `--shadow <worker>` needs none.
- The modes are described in `architecture/window.md`.

The owner's interactive loop is [Miko's window](/guide/miko-window).
