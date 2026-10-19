# Command form

Sessions here run in dontAsk mode: a command that does not match the allowlist is refused. Run a command in a
tree only as `pnpm --dir <tree> run|exec <x>` or `git -C <tree> <x>`, with no `cd`, `&&`, pipes, redirects or
environment prefixes. Read and write files with Read, Edit and Write, never through the shell. A command your
prompt or your agent file gives verbatim is run as written. A refused command is not worked around: stop and
return its exact text.
