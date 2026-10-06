#!/bin/sh
prompt=$(cat)
here=$(dirname "$0")
printf '%s\n' "$prompt" | sh "$here/claude-stub.sh" "$@" || exit $?
report=$(printf '%s\n' "$prompt" | sed -n 's/.*write the shift report to `\([^`]*\)`.*/\1/p' | head -n 1)
[ -f "$report" ] || exit 0
number=$(printf '%s\n' "$prompt" | sed -n 's/.*STUB-PR-\([0-9][0-9]*\).*/\1/p' | head -n 1)
if [ -n "$number" ]; then
  sed "s/^PR #1\$/PR #$number/" "$report" > "$report.tmp" && mv "$report.tmp" "$report"
fi
case "$prompt" in *STUB-PROBE-CLOSE*) printf 'Report: %s/probe.md\nverification: run\n' "$PWD" >> "$report" ;; esac
