#!/bin/sh
first=$(head -n 1)
command=$(printf '%s\n' "$first" | sed -n 's/^[^`]*`\([^`]*\)`.*/\1/p')
[ -n "$command" ] || exit 0
set -f
set -- $command
"$@"
