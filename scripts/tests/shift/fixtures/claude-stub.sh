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
runs=$(( $(cat "$STUB_OUT/$task.runs" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$runs" > "$STUB_OUT/$task.runs"
printf '%s\n' "$PWD" > "$STUB_OUT/$task.cwd"
printf '%s\n' "$session" > "$STUB_OUT/$task.session"
printf '%s\n' "$session" > "$STUB_OUT/$task.session.$runs"
printf '%s\n' "$flags" > "$STUB_OUT/$task.flags"
printf '%s\n' "$prompt" > "$STUB_OUT/$task.prompt"
printf '%s\n' "$prompt" > "$STUB_OUT/$task.prompt.$runs"
eddies() {
  mkdir -p "$PWD/.construct"
  printf '{"event":"%s","level":"session-context","spent":200000,"limit":250000,"tool":null,"at":"x","session_id":"%s"}\n' "$1" "$session" >> "$PWD/.construct/eddies.jsonl"
}
case "$prompt" in *STUB-WARN-ALWAYS*) : > "$STUB_OUT/$task.warn-always" ;; esac
case "$prompt" in *STUB-WARN*|*STUB-STOP*|*STUB-CLOSE*|*STUB-QUESTION*|*STUB-REFUSED*) eddies budget-warn ;; *) [ -e "$STUB_OUT/$task.warn-always" ] && eddies budget-warn ;; esac
case "$prompt" in *STUB-STOP*) eddies budget-stop ;; esac
case "$prompt" in *STUB-REFUSED*) printf '{"v":1,"event":"unread","hook":"eddies-guard","reason":"config-missing","session_id":"%s","agent_id":null,"at":"x"}\n' "$session" >> "$PWD/.construct/eddies.jsonl" ;; esac
case "$prompt" in *STUB-CLOSE*) printf '{"event":"path","task":"%s","path":"cheap","pr":1,"verification":"run","ts":"x"}\n' "${task#mc-}" >> "$CONSTRUCT_HANDOFF_DIR/ghosts.jsonl" ;; esac
case "$prompt" in *STUB-FAIL*) exit 1 ;; *STUB-SILENT*) exit 0 ;; esac
report=$(printf '%s\n' "$prompt" | sed -n 's/.*write the shift report to `\([^`]*\)`.*/\1/p' | head -n 1)
case "$prompt" in *STUB-NO-PR*) pr='no PR' ;; *) pr='PR #1' ;; esac
printf 'result: did %s\n%s\n' "$task" "$pr" > "$report"
case "$prompt" in *STUB-VERIFIED-*) printf 'verification: %s\n' "$(printf '%s\n' "$prompt" | sed -n 's/.*STUB-VERIFIED-\([a-z-]*\).*/\1/p' | head -n 1)" >> "$report" ;; esac
case "$prompt" in *STUB-QUESTION*) printf 'question: which way, owner?\n' >> "$report" ;; esac
