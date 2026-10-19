# Command form

For a role agent with Bash (implementer, harness, review, brief, scan, architect). In a dontAsk session a
command off the allowlist is refused. Run a command in a tree only as `pnpm --dir <tree> run|exec <x>` or
`git -C <tree> <x>`: no `cd`, `&&`, pipes, redirects or env prefixes. Use Read, Edit and Write for files. A
command your prompt or agent file gives verbatim runs as written. Never work around a refusal: stop and return
the exact command.
