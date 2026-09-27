#!/usr/bin/env bash
set -euo pipefail

KINDS='ok tampered unapproved failing occupied'
FAILING_EXIT=3

fail() {
  echo "world.sh $CHECK: $*" >&2
  exit 1
}

git_quiet() {
  git -c user.name=world -c user.email=world@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main "$@" >/dev/null 2>&1
}

implement_sha() {
  sed -n '/^\/implement /,$p' "$1" | shasum -a 256 | cut -c1-64
}

approved_sha() {
  sed -n 's/.*sha256: *\([0-9a-f]\{64\}\).*/\1/p' "$1" | head -n 1
}

stub_stdout() {
  printf '{"type":"system","subtype":"init","ghost":"%s"}\n' "$1"
  printf '{"type":"result","subtype":"success","ghost":"%s"}\n' "$1"
}

origin_sha() {
  git -C "$1/origin.git" rev-parse main
}

write_brief() {
  local W=$1 id=$2
  cat >"$W/handoff/brief-$id.md" <<EOF
# Brief $id (world fixture)

The header is not part of the approved text; the text below is sent as /implement to the session.

---

/implement Ghost $id: print \`hello $id\` with "double" and 'single' quotes; it's fine.

Design:
- A line with a backslash \\ and a dollar \$HOME that must stay literal.

Acceptance: the ghost prints hello — witness: \`echo "hello $id"\`
EOF
  printf 'approved /implement text sha256: %s (2026-09-27, world)\n' "$(implement_sha "$W/handoff/brief-$id.md")" >"$W/handoff/brief-$id.approved-sha256"
}

write_status() {
  local W=$1 kind=$2 base
  base=$(git -C "$W/main" rev-parse --short HEAD)
  {
    cat <<'EOF'
# Ghosts — window status

Machine-readable. One row per window; **each window edits only its own row**, with a one-line replacement, never by
rewriting the file.

| window | tree | state | sha | task start | waits for | updated |
|---|---|---|---|---|---|---|
| A | — | free | bc27f2c | — | window B's ladder | 2026-09-27 21:26 |
|  C  |   —   | free |  9513121 | —  |   (by A)  window closed;  uneven   spaces | 2026-09-27 19:08 |
EOF
    if [ "$kind" = occupied ]; then
      printf '| ghost-g1 | %s | writing | %s | 2026-09-27 20:00 | /implement brief-g1.md, session 00000000-0000-4000-8000-000000000000 | 2026-09-27 20:00 |\n' "$W/wt-g1" "$base"
    fi
    cat <<'EOF'

| policy | value | set by | updated |
|---|---|---|---|
| release-gate | the next release follows the merge of the whole chain | Eli | 2026-09-27 20:41 |
| owner-merges | `owner-merges.md` next to this file | Eli | 2026-09-27 18:50 |
EOF
  } >"$W/handoff/status.md"
}

write_stub() {
  local W=$1 kind=$2 failing_basename=none
  [ "$kind" = failing ] && failing_basename=wt-g2
  cat >"$W/bin/claude" <<EOF
#!/usr/bin/env bash
set -euo pipefail
dir='$W/stub'/"\$(basename "\$PWD")"
mkdir -p "\$dir"
printf '%s\0' "\$@" >"\$dir/argv"
pwd -P >"\$dir/cwd"
printf '%s\n' "\${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS-unset}" >"\$dir/ceiling"
cp '$W/handoff/status.md' "\$dir/status-at-start"
printf '{"type":"system","subtype":"init","ghost":"%s"}\n' "\$(basename "\$PWD")"
printf '{"type":"result","subtype":"success","ghost":"%s"}\n' "\$(basename "\$PWD")"
[ "\$(basename "\$PWD")" = '$failing_basename' ] && exit $FAILING_EXIT
exit 0
EOF
  chmod +x "$W/bin/claude"
}

write_tasks() {
  local W=$1
  cat >"$W/tasks.json" <<EOF
{ "repo": "$W/main", "status": "$W/handoff/status.md", "out": "$W/handoff", "tasks": [
  { "id": "g1", "brief": "$W/handoff/brief-g1.md", "worktree": "$W/wt-g1", "branch": "ghost/g1" },
  { "id": "g2", "brief": "$W/handoff/brief-g2.md", "worktree": "$W/wt-g2", "branch": "ghost/g2" }
] }
EOF
}

new_world() {
  local kind=$1 W
  case " $KINDS " in *" $kind "*) ;; *) echo "world.sh new: unknown kind '$kind' (one of: $KINDS)" >&2; exit 2 ;; esac
  W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ghost-world.XXXXXX")" && pwd -P)
  mkdir -p "$W/.world" "$W/handoff" "$W/bin" "$W/stub"

  git_quiet init --bare "$W/origin.git"
  git_quiet clone "$W/origin.git" "$W/.world/seed"
  echo one >"$W/.world/seed/file.txt"
  git_quiet -C "$W/.world/seed" add file.txt
  git_quiet -C "$W/.world/seed" commit -m one
  git_quiet -C "$W/.world/seed" push origin HEAD:main
  git_quiet clone "$W/origin.git" "$W/main"
  echo two >>"$W/.world/seed/file.txt"
  git_quiet -C "$W/.world/seed" commit -am two
  git_quiet -C "$W/.world/seed" push origin HEAD:main

  write_brief "$W" g1
  write_brief "$W" g2
  case $kind in
    tampered) sed -i.bak 's/^\/implement Ghost g2:/\/implement Ghost g3:/' "$W/handoff/brief-g2.md" && rm "$W/handoff/brief-g2.md.bak" ;;
    unapproved) rm "$W/handoff/brief-g2.approved-sha256" ;;
    occupied) mkdir -p "$W/wt-g2" && echo occupied >"$W/wt-g2/keep.txt" ;;
  esac
  write_status "$W" "$kind"
  write_stub "$W" "$kind"
  write_tasks "$W"

  echo "$kind" >"$W/.world/kind"
  cp "$W/handoff/status.md" "$W/.world/status.md"
  (cd "$W" && ls -d wt-* 2>/dev/null || true) >"$W/.world/wt-before"
  echo "$W"
}

expected_exit() {
  if [ "$(cat "$1/.world/kind")" = failing ] && [ "$2" = g2 ]; then echo $FAILING_EXIT; else echo 0; fi
}

read_argv() {
  ARGV=()
  local item
  while IFS= read -r -d '' item; do ARGV+=("$item"); done <"$1"
}

session_of() {
  read_argv "$1/stub/wt-$2/argv"
  echo "${ARGV[9]:-}"
}

output_has() {
  grep -qF -- "$2" "$1/launch.out" || fail "launch.out does not contain '$2'"
}

check_decision() {
  local W=$1 sha id
  [ -f "$W/launch.out" ] || fail "no $W/launch.out"
  grep -qx 'DECISION: open 2 sessions' "$W/launch.out" || fail "no line 'DECISION: open 2 sessions'"
  sha=$(origin_sha "$W")
  for id in g1 g2; do
    output_has "$W" "$W/handoff/brief-$id.md"
    output_has "$W" "$W/wt-$id"
    output_has "$W" "ghost/$id"
    output_has "$W" "${sha:0:7}"
    output_has "$W" "$(approved_sha "$W/handoff/brief-$id.approved-sha256" | cut -c1-7)"
    output_has "$W" "$W/handoff/ghost-$id.jsonl"
  done
}

check_untouched() {
  local W=$1 now
  now=$(cd "$W" && ls -d wt-* 2>/dev/null || true)
  [ "$now" = "$(cat "$W/.world/wt-before")" ] || fail "worktree paths changed: before '$(tr '\n' ' ' <"$W/.world/wt-before")', now '$(echo "$now" | tr '\n' ' ')'"
  [ -z "$(git -C "$W/main" branch --list 'ghost/*')" ] || fail "ghost/* branches exist: $(git -C "$W/main" branch --list 'ghost/*' | tr '\n' ' ')"
  cmp -s "$W/.world/status.md" "$W/handoff/status.md" || fail "status.md differs from the original"
  [ -z "$(ls -A "$W/stub")" ] || fail "the stub ran: $(ls -A "$W/stub" | tr '\n' ' ')"
  [ -z "$(cd "$W/handoff" && ls ghost-*.jsonl 2>/dev/null || true)" ] || fail "a ghost-*.jsonl exists in $W/handoff"
}

check_refused() {
  local W=$1 kind
  [ -f "$W/launch.out" ] || fail "no $W/launch.out"
  ! grep -q 'DECISION:' "$W/launch.out" || fail "launch.out has a DECISION: line"
  kind=$(cat "$W/.world/kind")
  case $kind in
    tampered)
      output_has "$W" "brief-g2.md"
      output_has "$W" "$(approved_sha "$W/handoff/brief-g2.approved-sha256")"
      output_has "$W" "$(implement_sha "$W/handoff/brief-g2.md")"
      ;;
    unapproved)
      output_has "$W" "brief-g2.md"
      grep -qiF 'no approval' "$W/launch.out" || fail "launch.out does not say 'no approval'"
      ;;
    occupied)
      output_has "$W" "$W/wt-g2"
      output_has "$W" "ghost-g1"
      output_has "$W" "writing"
      ;;
    *) fail "check-refused does not apply to a '$kind' world" ;;
  esac
}

check_launched() {
  local W=$1 sha id wt prompt session sessions=''
  sha=$(origin_sha "$W")
  for id in g1 g2; do
    wt="$W/wt-$id"
    [ -d "$wt" ] || fail "$id: no worktree $wt"
    [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "ghost/$id" ] || fail "$id: worktree is not on branch ghost/$id"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$sha" ] || fail "$id: worktree is at $(git -C "$wt" rev-parse HEAD), not origin/main $sha"
    [ -f "$W/stub/wt-$id/cwd" ] || fail "$id: the stub did not run in $wt"
    [ "$(cat "$W/stub/wt-$id/cwd")" = "$wt" ] || fail "$id: stub cwd is $(cat "$W/stub/wt-$id/cwd"), not $wt"
    read_argv "$W/stub/wt-$id/argv"
    [ "${#ARGV[@]}" -eq 11 ] || fail "$id: argv has ${#ARGV[@]} elements, not 11"
    [ "${ARGV[*]:0:9}" = '-p --output-format stream-json --verbose --permission-mode auto --permission-prompts none --session-id' ] || fail "$id: argv starts '${ARGV[*]:0:9}'"
    session=${ARGV[9]}
    echo "$session" | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || fail "$id: session id '$session' is not a uuid"
    prompt=${ARGV[10]}
    case $prompt in '/implement '*) ;; *) fail "$id: the prompt does not start with '/implement '" ;; esac
    [ "$(printf '%s' "$prompt" | shasum -a 256 | cut -c1-64)" = "$(approved_sha "$W/handoff/brief-$id.approved-sha256")" ] || fail "$id: the sha256 of the prompt is not the approved hash"
    [ "$(cat "$W/stub/wt-$id/ceiling")" = 0 ] || fail "$id: CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS is '$(cat "$W/stub/wt-$id/ceiling")', not 0"
    sessions="$sessions $session"
  done
  [ "$(echo $sessions | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" = 2 ] || fail "the two sessions share an id:$sessions"
}

window_table_lines() {
  awk '/^\| window \|/ { inside = 1 } inside && !/^\|/ { exit } inside { print NR }' "$1"
}

check_rows() {
  local W=$1 sha id wt row count session exit_code
  sha=$(origin_sha "$W")
  for id in g1 g2; do
    wt="$W/wt-$id"
    [ -f "$W/stub/wt-$id/status-at-start" ] || fail "$id: the stub did not run"
    row=$(grep -F "| ghost-$id | $wt | writing | " "$W/stub/wt-$id/status-at-start" || true)
    [ -n "$row" ] || fail "$id: no '| ghost-$id | $wt | writing |' row while the session ran"
    case "$sha" in "$(echo "$row" | awk -F' [|] ' '{ print $4 }')"*) ;; *) fail "$id: the writing row's sha is not origin/main $sha: $row" ;; esac
    [ "$(echo "$row" | awk -F' [|] ' '{ print length($4) }')" -ge 7 ] || fail "$id: the writing row's sha is shorter than 7: $row"

    count=$(grep -cF "| ghost-$id |" "$W/handoff/status.md" || true)
    [ "$count" = 1 ] || fail "$id: $count rows for ghost-$id in status.md, not 1"
    row=$(grep -F "| ghost-$id |" "$W/handoff/status.md")
    case $row in "| ghost-$id | $wt | free | "*) ;; *) fail "$id: the row after exit is not free: $row" ;; esac
    exit_code=$(expected_exit "$W" "$id")
    session=$(session_of "$W" "$id")
    for part in "exit $exit_code" "report $W/handoff/ghost-$id.jsonl" "session $session"; do
      echo "$row" | grep -qF -- "$part" || fail "$id: the free row lacks '$part': $row"
    done
    window_table_lines "$W/handoff/status.md" | grep -qx "$(grep -nF "| ghost-$id |" "$W/handoff/status.md" | cut -d: -f1)" || fail "$id: the row is not in the window table"
  done
  grep -vF '| ghost-' "$W/handoff/status.md" | cmp -s - "$W/.world/status.md" || fail "a byte of status.md outside the ghost rows changed"
}

check_report() {
  local W=$1 id
  for id in g1 g2; do
    [ -f "$W/handoff/ghost-$id.jsonl" ] || fail "$id: no $W/handoff/ghost-$id.jsonl"
    stub_stdout "wt-$id" | cmp -s - "$W/handoff/ghost-$id.jsonl" || fail "$id: ghost-$id.jsonl is not the stub's stdout byte for byte"
    grep -F "| ghost-$id |" "$W/handoff/status.md" | grep -qF "report $W/handoff/ghost-$id.jsonl" || fail "$id: the free row does not name $W/handoff/ghost-$id.jsonl"
  done
}

CHECK=${1:-}
case $CHECK in
  new) new_world "${2:?usage: world.sh new <$KINDS>}" ;;
  check-decision | check-untouched | check-refused | check-launched | check-rows | check-report)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    fn=${CHECK#check-}
    "check_$fn" "$W"
    ;;
  *) echo "usage: world.sh new <${KINDS// /|}> | world.sh check-<decision|untouched|refused|launched|rows|report> <world>" >&2; exit 2 ;;
esac
