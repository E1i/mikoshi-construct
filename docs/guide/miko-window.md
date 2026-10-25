# Miko's window

`pnpm miko` opens the interactive window the owner works in: a loop in the current terminal. It signs its
messages `[mikoshi]` and hands itself on by writing `miko.md` and ending its process, and the loop starts
the next one ([README, Mikoshi, constructs and other words](https://github.com/E1i/mikoshi-construct#mikoshi-constructs-and-other-words)).
The loop is `scripts/window/loop.ts`; its siblings in `scripts/window/` are `pnpm miko:watch`,
`pnpm miko:pull`, `pnpm miko:exit` and the handoff scripts.

- The owner's decisions reach the factory only through `construct say`, which writes to
  `~/.construct-owner/answers/` ([CLI reference](/cli#construct-say)).
- `construct board` shows the window beside the bus pulse ([CLI reference](/cli#construct-board)).
- The window's rules are `architecture/window.md` and `architecture/window-core.md`.
- In a repository only attached, the window hooks are described under
  [the window hooks](/cli#the-window-hooks).

The factory around the window is [the factory and its two modes](/guide/factory).
