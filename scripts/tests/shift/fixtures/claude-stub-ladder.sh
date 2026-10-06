#!/bin/sh
prompt=$(cat)
here=$(dirname "$0")
printf '%s\n' "$prompt" | sh "$here/claude-stub-pr.sh" "$@" || exit $?
brief=$(printf '%s\n' "$prompt" | sed -n 's/.*write the brief to `\([^`]*\)`.*/\1/p' | head -n 1)
case "$prompt" in
  *STUB-BRIEF-WRITE*)
    if [ -n "$brief" ]; then
      printf '/implement stub brief\nSketch: none — stub\n' > "$brief"
    fi
    ;;
esac
exit 0
