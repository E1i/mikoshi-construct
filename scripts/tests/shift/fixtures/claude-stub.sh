#!/bin/sh
session=""
flags=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) session="$2"; shift 2 ;;
    *) flags="$flags $1"; shift ;;
  esac
done
prompt=$(cat)
task=$(basename "$PWD")
printf '%s\n' "$PWD" > "$STUB_OUT/$task.cwd"
printf '%s\n' "$session" > "$STUB_OUT/$task.session"
printf '%s\n' "$flags" > "$STUB_OUT/$task.flags"
printf '%s\n' "$prompt" > "$STUB_OUT/$task.prompt"
case "$prompt" in *STUB-FAIL*) exit 1 ;; *STUB-SILENT*) exit 0 ;; esac
report=$(printf '%s\n' "$prompt" | sed -n 's/.*write the shift report to `\([^`]*\)`.*/\1/p' | head -n 1)
printf 'result: did %s\nPR #1\n' "$task" > "$report"
