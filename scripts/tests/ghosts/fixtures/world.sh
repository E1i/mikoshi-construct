#!/usr/bin/env bash
set -euo pipefail

KINDS='ok tampered unapproved failing occupied with-matrix no-ladder no-result install-fails trailing-newline numeric-id install-unspawnable session-unspawnable two-implement journal-exists sketch sketch-no-line sketch-no-branch sketch-moved sketch-stale args-elsewhere args-rewritten row-without-hashes expect expect-none expect-malformed expect-misplaced'
ARGS_BROKEN_KINDS='args-elsewhere args-rewritten row-without-hashes'
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)
ARGS_PATH=.construct/implement-args.json
NUMERIC_ID=272
SEALED_PATH_TAIL=/usr/bin:/bin
CLEAN_SKETCH_LINE='Sketch: none — world fixture'
EXPECT_FORECAST_LINE='expect: tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median'
EXPECT_NONE_LINE='expect: none — n=3 for effort low'
EXPECT_MALFORMED_LINE='expect: tokens ≈ lots — effort medium, n=61, median'
EXPECT_MISPLACED_LINE='expect: none — written below the blank line'
CLEAN_SKETCH_REASON='world fixture'
FAILING_EXIT=3

fail() {
  echo "world.sh $CHECK: $*" >&2
  exit 1
}

git_quiet() {
  git -c user.name=world -c user.email=world@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main "$@" >/dev/null 2>&1
}

remove_world() {
  rm -rf "$1"
}

implement_sha() {
  printf '%s' "$(sed -n '/^\/implement /,$p' "$1")" | shasum -a 256 | cut -c1-64
}

approved_sha() {
  sed -n 's/.*sha256: *\([0-9a-f]\{64\}\).*/\1/p' "$1" | head -n 1
}

origin_sha() {
  git -C "$1/origin.git" rev-parse main
}

ids_for_kind() {
  if [ "$1" = numeric-id ]; then echo "g1 $NUMERIC_ID"; else echo 'g1 g2'; fi
}

ids_of() {
  cat "$1/.world/ids"
}

write_approval() {
  printf 'approved /implement text sha256: %s (2026-09-27, world)\n' "$(implement_sha "$1/handoff/brief-$2.md")" >"$1/handoff/brief-$2.approved-sha256"
}

sketch_line_for() {
  local W=$1 id=$2 kind
  kind=$(cat "$W/.world/kind")
  if [ "$id" != g2 ]; then echo "$CLEAN_SKETCH_LINE"; return; fi
  case $kind in
    sketch | sketch-no-branch | sketch-stale) echo "Sketch: sketch/g2 @ $(cat "$W/.world/sketch-tip")" ;;
    sketch-moved) echo "Sketch: sketch/g2 @ $(cat "$W/.world/sketch-parent")" ;;
    sketch-no-line) echo '' ;;
    *) echo "$CLEAN_SKETCH_LINE" ;;
  esac
}

expect_lines_for() {
  [ "$2" = g2 ] || return 0
  case $(cat "$1/.world/kind") in
    expect) printf '\n%s' "$EXPECT_FORECAST_LINE" ;;
    expect-none) printf '\n%s' "$EXPECT_NONE_LINE" ;;
    expect-malformed) printf '\n%s' "$EXPECT_MALFORMED_LINE" ;;
    expect-misplaced) printf '\n\n%s' "$EXPECT_MISPLACED_LINE" ;;
  esac
}

write_brief() {
  local W=$1 id=$2 text sketch_line
  sketch_line=$(sketch_line_for "$W" "$id")$(expect_lines_for "$W" "$id")
  cat >"$W/handoff/brief-$id.md" <<EOF
# Brief $id (world fixture)

The header is not part of the approved text; the text below is sent as /implement to the session.

---

/implement Ghost $id: print \`hello $id\` with "double" and 'single' quotes; it's fine.
$sketch_line

Design:
- A line with a backslash \\ and a dollar \$HOME that must stay literal.

Acceptance: the ghost prints hello — witness: \`echo "hello $id"\`
EOF
  text=$(cat "$W/handoff/brief-$id.md")
  printf '%s' "$text" >"$W/handoff/brief-$id.md"
  write_approval "$W" "$id"
}

insert_header_implement_line() {
  local W=$1 id=$2
  awk 'NR == 4 { print "/implement regex wrapped out of the header prose above, not the text to run" } { print }' "$W/handoff/brief-$id.md" >"$W/.world/brief-$id.two"
  printf '%s' "$(cat "$W/.world/brief-$id.two")" >"$W/handoff/brief-$id.md"
  write_approval "$W" "$id"
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

write_results() {
  local W=$1
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":9.99,"num_turns":99,"duration_ms":99999,"usage":{"input_tokens":999,"output_tokens":999}}' >"$W/.world/result-g1-early.json"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.5,"num_turns":7,"duration_ms":1000,"usage":{"input_tokens":11,"output_tokens":22,"cache_read_input_tokens":33}}' >"$W/.world/result-g1.json"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.25,"num_turns":3,"duration_ms":500,"usage":{"input_tokens":44,"output_tokens":55}}' >"$W/.world/result-g2.json"
  if [ "$(cat "$W/.world/kind")" = numeric-id ]; then
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.75,"num_turns":5,"duration_ms":700,"usage":{"input_tokens":66,"output_tokens":77}}' >"$W/.world/result-$NUMERIC_ID.json"
  fi
}

write_stub() {
  local W=$1
  printf '#!/usr/bin/env bash\nset -euo pipefail\nW=%q\nFAILING_EXIT=%q\nCHECK_ACCEPTANCE=%q\nARGS_PATH=%q\n' "$W" "$FAILING_EXIT" "$REPO_ROOT/scripts/construct/check-acceptance.mjs" "$ARGS_PATH" >"$W/bin/claude"
  cat >>"$W/bin/claude" <<'EOF'
ghost=$(basename "$PWD")
id=${ghost#wt-}
kind=$(cat "$W/.world/kind")
dir="$W/stub/$ghost"
mkdir -p "$dir"
printf '%s\0' "$@" >"$dir/argv"
pwd -P >"$dir/cwd"
printf '%s\n' "${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS-unset}" >"$dir/ceiling"
cp "$W/handoff/status.md" "$dir/status-at-start"
if [ -f "$PWD/.ghost-installed" ]; then echo yes; else echo no; fi >"$dir/installed-at-start"
if [ -f "$PWD/.construct/implement-agreed.txt" ]; then cp "$PWD/.construct/implement-agreed.txt" "$dir/agreed-at-start"; fi
: >"$dir/stdout"
emit() { printf '%s\n' "$1" >>"$dir/stdout"; printf '%s\n' "$1"; }
emit "{\"type\":\"system\",\"subtype\":\"init\",\"ghost\":\"$ghost\"}"
[ "$id" = g1 ] && emit "$(cat "$W/.world/result-g1-early.json")"
emit "{\"type\":\"user\",\"ghost\":\"$ghost\",\"timestamp\":\"2026-09-27T20:00:00.000Z\"}"
emit "{\"type\":\"assistant\",\"ghost\":\"$ghost\",\"timestamp\":\"2026-09-27T20:07:10.500Z\"}"
agreed=.construct/implement-agreed.txt
if [ "$kind" = args-elsewhere ] && [ "$id" = g2 ]; then
  sed 's/^\/implement Ghost g2:/\/implement Ghost g2, changed after approval:/' "$agreed" >"$dir/agreed-elsewhere.txt"
  agreed="$dir/agreed-elsewhere.txt"
fi
node "$CHECK_ACCEPTANCE" build --brief "$agreed" --out "$ARGS_PATH" >"$dir/handle"
handle_field() { node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' "$dir/handle" "$1"; }
hashes=",\"agreedSha256\":\"$(handle_field agreedSha256)\",\"argsSha256\":\"$(handle_field argsSha256)\""
[ "$kind" = row-without-hashes ] && [ "$id" = g2 ] && hashes=''
status=done
[ "$kind" = failing ] && [ "$id" = g2 ] && status=failed
[ "$kind" = no-ladder ] && [ "$id" = g2 ] && status=none
if [ "$status" != none ]; then
  attempts='[{"rung":1,"effort":"low","outcome":"done","reason":""}]'
  [ "$id" = g1 ] && attempts='[{"rung":1,"effort":"low","outcome":"harness failed","reason":""},{"rung":2,"effort":"medium","outcome":"done","reason":""}]'
  printf '{"run":"run-%s","at":"2026-09-27T20:00:00.000Z","task":"Ghost %s","effort":"low","status":"%s","rung":"low","attempts":%s,"agents":3,"tokens":100,"toolUses":4,"seconds":10%s}\n' "$id" "$id" "$status" "$attempts" "$hashes" >>"$PWD/.construct/runs.jsonl"
fi
if [ "$kind" = args-rewritten ] && [ "$id" = g2 ]; then
  node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1], "utf8")), null, 2))' "$ARGS_PATH"
fi
if ! { [ "$kind" = no-result ] && [ "$id" = g2 ]; }; then
  emit "$(cat "$W/.world/result-$id.json")"
fi
[ "$kind" = failing ] && [ "$id" = g2 ] && exit "$FAILING_EXIT"
exit 0
EOF
  chmod +x "$W/bin/claude"

  printf '#!/usr/bin/env bash\nset -euo pipefail\nW=%q\nREAL_PNPM=%q\n' "$W" "$(command -v pnpm)" >"$W/bin/pnpm"
  cat >>"$W/bin/pnpm" <<'EOF'
if [ "$#" -eq 2 ] && [ "$1" = install ] && [ "$2" = --frozen-lockfile ]; then
  ghost=$(basename "$PWD")
  dir="$W/stub/$ghost"
  mkdir -p "$dir"
  printf '%s\0' "$@" >"$dir/pnpm-argv"
  pwd -P >"$dir/pnpm-cwd"
  echo "stub install in $ghost"
  if [ "$(cat "$W/.world/kind")" = session-unspawnable ] && [ "$ghost" = wt-g2 ]; then
    waited=0
    while [ ! -f "$W/stub/wt-g1/argv" ]; do
      if [ "$waited" -ge 300 ]; then
        echo 'stub install gave up: the session of g1 did not start while g2 was installing' >&2
        exit 1
      fi
      sleep 0.1
      waited=$((waited + 1))
    done
    rm -f "$W/bin/claude"
  fi
  if [ "$(cat "$W/.world/kind")" = install-fails ] && [ "$ghost" = wt-g2 ]; then
    echo 'stub install failed: lockfile out of date' >&2
    exit 1
  fi
  touch "$PWD/.ghost-installed"
  exit 0
fi
exec "$REAL_PNPM" "$@"
EOF
  chmod +x "$W/bin/pnpm"
}

seal_path() {
  local W=$1 kind=$2
  ln -s "$(command -v node)" "$W/bin/node"
  ln -s "$(command -v git)" "$W/bin/git"
  case $kind in
    install-unspawnable) rm "$W/bin/pnpm" ;;
    session-unspawnable) mv "$W/bin/claude" "$W/.world/claude" && ln -s "$W/.world/claude" "$W/bin/claude" ;;
  esac
  echo "$W/bin:$SEALED_PATH_TAIL" >"$W/.world/sealed-path"
}

write_matrix() {
  local W=$1
  cat >"$W/matrix.json" <<'EOF'
{
  "vocabulary": [],
  "rows": [
    { "task": "g0", "class": "R1", "contour": { "after": [], "parallelWith": [], "worktree": "../mc-g0", "locks": [], "executor": "ladder", "merge": "auto", "capabilities": [], "notes": [] } },
    { "task": "g1", "class": "R2", "contour": { "after": ["PR #1"], "parallelWith": [], "worktree": "../mc-g1", "locks": [], "executor": "ladder", "merge": "auto", "capabilities": ["need code change"], "notes": [] } }
  ],
  "notChecked": []
}
EOF
}

write_numeric_matrix() {
  local W=$1
  cat >"$W/matrix.json" <<EOF
{
  "vocabulary": [],
  "rows": [
    { "task": "$NUMERIC_ID", "class": "R7 bare-number decoy", "contour": { "after": [], "parallelWith": [], "worktree": "../mc-decoy-bare", "locks": [], "executor": "ladder", "merge": "auto", "capabilities": [], "notes": ["decoy"] } },
    { "task": "#g1", "class": "R8 hash-prefix decoy", "contour": { "after": [], "parallelWith": [], "worktree": "../mc-decoy-hash", "locks": [], "executor": "ladder", "merge": "auto", "capabilities": [], "notes": ["decoy"] } },
    { "task": "#$NUMERIC_ID", "class": "R3", "contour": { "after": ["PR #2"], "parallelWith": ["g1"], "worktree": "../mc-$NUMERIC_ID", "locks": [], "executor": "ladder", "merge": "owner", "capabilities": [], "notes": [] } },
    { "task": "g1", "class": "R2", "contour": { "after": ["PR #1"], "parallelWith": [], "worktree": "../mc-g1", "locks": [], "executor": "ladder", "merge": "auto", "capabilities": ["need code change"], "notes": [] } }
  ],
  "notChecked": []
}
EOF
}

write_tasks() {
  local W=$1 kind=$2 matrix='' id sep='' entries=''
  case $kind in with-matrix | numeric-id) matrix="\"matrix\": \"$W/matrix.json\", " ;; esac
  for id in $(ids_of "$W"); do
    entries="$entries$sep  { \"id\": \"$id\", \"brief\": \"$W/handoff/brief-$id.md\", \"worktree\": \"$W/wt-$id\", \"branch\": \"ghost/$id\" }"
    sep=$',\n'
  done
  cat >"$W/tasks.json" <<EOF
{ "repo": "$W/main", "status": "$W/handoff/status.md", "out": "$W/handoff", $matrix"tasks": [
$entries
] }
EOF
}

commit_sketch_in_seed() {
  local W=$1 seed="$1/.world/seed" parent=$2
  git_quiet -C "$seed" checkout -q --detach "$parent"
  echo 'sketch g2' >"$seed/sketch.txt"
  git_quiet -C "$seed" add sketch.txt
  git_quiet -C "$seed" commit -m 'sketch g2'
  git -C "$seed" rev-parse HEAD >"$W/.world/sketch-tip"
  git -C "$seed" rev-parse "$parent" >"$W/.world/sketch-parent"
  git_quiet -C "$seed" checkout -q main
}

make_sketch() {
  local W=$1 kind=$2 seed="$1/.world/seed" parent=main
  case $kind in sketch | sketch-no-branch | sketch-moved | sketch-stale) ;; *) return ;; esac
  [ "$kind" = sketch-stale ] && parent='main~1'
  commit_sketch_in_seed "$W" "$parent"
  case $kind in
    sketch-no-branch) ;;
    *) git_quiet -C "$seed" push "$W/main" "$(cat "$W/.world/sketch-tip"):refs/heads/sketch/g2" ;;
  esac
}

new_world() {
  local kind=$1 W
  case " $KINDS " in *" $kind "*) ;; *) echo "world.sh new: unknown kind '$kind' (one of: $KINDS)" >&2; exit 2 ;; esac
  W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/ghost-world.XXXXXX")" && pwd -P)
  trap "remove_world $(printf %q "$W")" EXIT
  mkdir -p "$W/.world" "$W/handoff" "$W/bin" "$W/stub"

  git_quiet init --bare "$W/origin.git"
  git_quiet clone "$W/origin.git" "$W/.world/seed"
  echo one >"$W/.world/seed/file.txt"
  printf '%s\n' '{"harness":{"command":"pnpm run quality"}}' >"$W/.world/seed/construct.json"
  mkdir -p "$W/.world/seed/.construct"
  printf '%s\n' '{"run":"run-old","at":"2026-09-26T10:00:00.000Z","task":"an earlier run","effort":"low","status":"done","rung":"low","attempts":[{"rung":1,"effort":"low","outcome":"done","reason":""}],"agents":3,"tokens":100,"toolUses":4,"seconds":10}' >"$W/.world/seed/.construct/runs.jsonl"
  git_quiet -C "$W/.world/seed" add file.txt construct.json .construct/runs.jsonl
  git_quiet -C "$W/.world/seed" commit -m one
  git_quiet -C "$W/.world/seed" push origin HEAD:main
  git_quiet clone "$W/origin.git" "$W/main"
  echo two >>"$W/.world/seed/file.txt"
  git_quiet -C "$W/.world/seed" commit -am two
  git_quiet -C "$W/.world/seed" push origin HEAD:main

  echo "$kind" >"$W/.world/kind"
  make_sketch "$W" "$kind"
  ids_for_kind "$kind" >"$W/.world/ids"
  for id in $(ids_of "$W"); do write_brief "$W" "$id"; done
  case $kind in
    tampered) sed -i.bak 's/^\/implement Ghost g2:/\/implement Ghost g3:/' "$W/handoff/brief-g2.md" && rm "$W/handoff/brief-g2.md.bak" ;;
    unapproved) rm "$W/handoff/brief-g2.approved-sha256" ;;
    occupied) mkdir -p "$W/wt-g2" && echo occupied >"$W/wt-g2/keep.txt" ;;
    trailing-newline) printf '\n\n\n' >>"$W/handoff/brief-g2.md" ;;
    two-implement) insert_header_implement_line "$W" g2 ;;
    journal-exists) printf '%s\n' '{"event":"review","task":"g0","verdict":"changes","ts":"2026-09-27T20:00:00.000Z"}' >"$W/handoff/ghosts.jsonl" && cp "$W/handoff/ghosts.jsonl" "$W/.world/ghosts.jsonl" ;;
  esac
  echo "$kind" >"$W/.world/kind"
  write_status "$W" "$kind"
  write_results "$W"
  write_stub "$W"
  case $kind in install-unspawnable | session-unspawnable) seal_path "$W" "$kind" ;; esac
  if [ "$kind" = numeric-id ]; then write_numeric_matrix "$W"; else write_matrix "$W"; fi
  write_tasks "$W" "$kind"

  cp "$W/handoff/status.md" "$W/.world/status.md"
  (cd "$W" && ls -d wt-* 2>/dev/null || true) >"$W/.world/wt-before"
  trap - EXIT
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
  echo "${ARGV[10]:-}"
}

output_has() {
  grep -qF -- "$2" "$1/launch.out" || fail "launch.out does not contain '$2'"
}

sketch_task_in() {
  [ "$(cat "$1/.world/kind")" = sketch ] && [ "$2" = g2 ]
}

expected_sketch_description() {
  if sketch_task_in "$1" "$2"; then
    echo "from sketch sketch/g2 @ $(cut -c1-7 "$1/.world/sketch-tip")"
  else
    echo "clean tree ($CLEAN_SKETCH_REASON)"
  fi
}

expected_expect_description() {
  case "$(cat "$1/.world/kind"):$2" in
    expect:g2) echo "expect ${EXPECT_FORECAST_LINE#expect: }" ;;
    expect-none:g2) echo "expect ${EXPECT_NONE_LINE#expect: }" ;;
    *) echo 'expect —' ;;
  esac
}

task_line_ends_with() {
  local line
  line=$(grep -F -- "  $2: /implement" "$1/launch.out" | head -n 1)
  [[ $line == *", $3" ]] || fail "the task line of $2 does not end with ', $3': '$line'"
}

check_decision() {
  local W=$1 sha id
  [ -f "$W/launch.out" ] || fail "no $W/launch.out"
  grep -qx 'DECISION: open 2 sessions' "$W/launch.out" || fail "no line 'DECISION: open 2 sessions'"
  sha=$(origin_sha "$W")
  for id in $(ids_of "$W"); do
    output_has "$W" "$W/handoff/brief-$id.md"
    output_has "$W" "$W/wt-$id"
    output_has "$W" "ghost/$id"
    output_has "$W" "${sha:0:7}"
    output_has "$W" "$(approved_sha "$W/handoff/brief-$id.approved-sha256" | cut -c1-7)"
    output_has "$W" "$W/handoff/ghost-$id.jsonl"
    output_has "$W" "@ ${sha:0:7} $(expected_sketch_description "$W" "$id"), report $W/handoff/ghost-$id.jsonl"
    task_line_ends_with "$W" "$id" "$(expected_expect_description "$W" "$id")"
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
    two-implement)
      check_refused_two_implement "$W"
      ;;
    sketch-no-line)
      output_has "$W" "task g2: $W/handoff/brief-g2.md: line 2 of the /implement text does not start with 'Sketch: '"
      ;;
    sketch-no-branch)
      output_has "$W" "task g2: sketch branch sketch/g2 does not exist in $W/main"
      ;;
    sketch-moved)
      output_has "$W" "task g2: sketch branch sketch/g2 is at $(cat "$W/.world/sketch-tip"), not the approved $(cat "$W/.world/sketch-parent")"
      ;;
    expect-malformed)
      output_has "$W" "task g2: $W/handoff/brief-g2.md: the expect: line is neither"
      output_has "$W" "\"$EXPECT_MALFORMED_LINE\""
      ;;
    expect-misplaced)
      output_has "$W" "task g2: $W/handoff/brief-g2.md: an expect: line may stand only on line 3 of the /implement text, and line 4 is \"$EXPECT_MISPLACED_LINE\""
      ;;
    sketch-stale)
      output_has "$W" "task g2: sketch $(cut -c1-7 "$W/.world/sketch-tip") does not contain origin/main $(origin_sha "$W" | cut -c1-7); rebase sketch/g2 onto origin/main and re-approve the brief"
      ;;
    *) fail "check-refused does not apply to a '$kind' world" ;;
  esac
}

names_every_number() {
  local line=$1 numbers=$2 n
  line=$(echo "$line" | sed -E 's/[0-9a-f-]{7,}//g')
  for n in $numbers; do
    echo "$line" | grep -Eq "(^|[^0-9])$n([^0-9]|\$)" || return 1
  done
}

check_refused_two_implement() {
  local W=$1 numbers line found=no
  numbers=$(grep -n '^/implement ' "$W/handoff/brief-g2.md" | cut -d: -f1 | tr '\n' ' ')
  [ "$(echo $numbers | wc -w | tr -d ' ')" = 2 ] || fail "the world's brief-g2.md does not have two /implement lines: $numbers"
  while IFS= read -r line; do
    if names_every_number "${line//$W/}" "$numbers"; then found=yes; fi
  done < <(grep -F 'brief-g2.md' "$W/launch.out" || true)
  [ "$found" = yes ] || fail "no line of launch.out names brief-g2.md with the line numbers of its /implement lines ($numbers)"
  ! grep -qF 'brief-g1.md' "$W/launch.out" || fail "launch.out names brief-g1.md, whose one /implement line is approved: $(grep -F 'brief-g1.md' "$W/launch.out" | head -n 1)"
}

check_sketch() {
  local W=$1 sha id wt unstaged
  [ "$(kind_of "$W")" = sketch ] || fail "check-sketch applies to a sketch world only"
  sha=$(origin_sha "$W")
  for id in $(ids_of "$W"); do
    wt="$W/wt-$id"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$sha" ] || fail "$id: HEAD is $(git -C "$wt" rev-parse HEAD), not origin/main $sha"
    [ "$(git -C "$wt" rev-parse "ghost/$id")" = "$sha" ] || fail "$id: the branch ghost/$id is not at origin/main $sha"
    unstaged=$(git -C "$wt" diff --name-only | grep -v '^\.construct/' || true)
    [ -z "$unstaged" ] || fail "$id: unstaged changes outside .construct/: $unstaged"
    if sketch_task_in "$W" "$id"; then
      [ "$(git -C "$wt" diff --cached --name-only)" = sketch.txt ] || fail "$id: the staged paths are '$(git -C "$wt" diff --cached --name-only | tr '\n' ' ')', not sketch.txt"
      [ "$(cat "$wt/sketch.txt")" = 'sketch g2' ] || fail "$id: sketch.txt in the worktree does not read 'sketch g2'"
      [ "$(git -C "$wt" write-tree)" = "$(git -C "$W/main" rev-parse 'sketch/g2^{tree}')" ] || fail "$id: the index is not the tree of sketch/g2"
      [ "$(git -C "$W/main" rev-parse sketch/g2)" = "$(cat "$W/.world/sketch-tip")" ] || fail "sketch/g2 moved"
    else
      [ -z "$(git -C "$wt" diff --cached --name-only)" ] || fail "$id: a clean-tree task has staged paths: $(git -C "$wt" diff --cached --name-only | tr '\n' ' ')"
      [ ! -e "$wt/sketch.txt" ] || fail "$id: a clean-tree task has sketch.txt"
    fi
  done
}

check_launched() {
  local W=$1 sha id wt prompt session sessions=''
  sha=$(origin_sha "$W")
  for id in $(ids_of "$W"); do
    wt="$W/wt-$id"
    [ -d "$wt" ] || fail "$id: no worktree $wt"
    [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "ghost/$id" ] || fail "$id: worktree is not on branch ghost/$id"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$sha" ] || fail "$id: worktree is at $(git -C "$wt" rev-parse HEAD), not origin/main $sha"
    [ -f "$W/stub/wt-$id/cwd" ] || fail "$id: the stub did not run in $wt"
    [ "$(cat "$W/stub/wt-$id/cwd")" = "$wt" ] || fail "$id: stub cwd is $(cat "$W/stub/wt-$id/cwd"), not $wt"
    read_argv "$W/stub/wt-$id/argv"
    [ "${#ARGV[@]}" -eq 12 ] || fail "$id: argv has ${#ARGV[@]} elements, not 12"
    [ "${ARGV[*]:0:10}" = '-p --output-format stream-json --verbose --permission-mode auto --permission-prompts none --strict-mcp-config --session-id' ] || fail "$id: argv starts '${ARGV[*]:0:10}'"
    session=${ARGV[10]}
    echo "$session" | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || fail "$id: session id '$session' is not a uuid"
    prompt=${ARGV[11]}
    case $prompt in '/implement '*) ;; *) fail "$id: the prompt does not start with '/implement '" ;; esac
    [ "$(printf '%s' "$prompt" | shasum -a 256 | cut -c1-64)" = "$(approved_sha "$W/handoff/brief-$id.approved-sha256")" ] || fail "$id: the sha256 of the prompt is not the approved hash"
    [ -f "$W/stub/wt-$id/agreed-at-start" ] || fail "$id: no .construct/implement-agreed.txt in $wt when the session started"
    [ "$(cat "$W/stub/wt-$id/agreed-at-start"; printf x)" = "${prompt}x" ] || fail "$id: .construct/implement-agreed.txt at session start is not the prompt byte for byte"
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
  for id in $(ids_of "$W"); do
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
  for id in $(ids_of "$W"); do
    [ -f "$W/handoff/ghost-$id.jsonl" ] || fail "$id: no $W/handoff/ghost-$id.jsonl"
    [ -f "$W/stub/wt-$id/stdout" ] || fail "$id: the stub did not run"
    cmp -s "$W/stub/wt-$id/stdout" "$W/handoff/ghost-$id.jsonl" || fail "$id: ghost-$id.jsonl is not the stub's stdout byte for byte"
    grep -F "| ghost-$id |" "$W/handoff/status.md" | grep -qF "report $W/handoff/ghost-$id.jsonl" || fail "$id: the free row does not name $W/handoff/ghost-$id.jsonl"
  done
}

kind_of() {
  cat "$1/.world/kind"
}

install_fails_for() {
  [ "$(kind_of "$1")" = install-fails ] && [ "$2" = g2 ]
}

install_unspawnable_for() {
  [ "$(kind_of "$1")" = install-unspawnable ]
}

session_unspawnable_for() {
  [ "$(kind_of "$1")" = session-unspawnable ] && [ "$2" = g2 ]
}

INSTALL_SPAWN_ERROR='spawn pnpm ENOENT'
SESSION_SPAWN_ERROR='spawn claude ENOENT'

expected_outcome() {
  local W=$1 id=$2
  if install_fails_for "$W" "$id"; then echo 'install failed: exit 1'
  elif install_unspawnable_for "$W" "$id"; then echo "install failed: $INSTALL_SPAWN_ERROR"
  elif session_unspawnable_for "$W" "$id"; then echo "session failed: $SESSION_SPAWN_ERROR"
  else expected_ladder "$W" "$id"
  fi
}

expected_ladder() {
  local W=$1 id=$2 kind
  kind=$(kind_of "$W")
  if install_fails_for "$W" "$id"; then echo 'no ladder run'
  elif [ "$kind" = no-ladder ] && [ "$id" = g2 ]; then echo 'no ladder run'
  elif [ "$kind" = failing ] && [ "$id" = g2 ]; then echo 'ladder failed'
  else echo 'ladder done'
  fi
}

check_ladder() {
  local W=$1 id row part
  for id in $(ids_of "$W"); do
    row=$(grep -F "| ghost-$id |" "$W/handoff/status.md" || true)
    case $row in "| ghost-$id | $W/wt-$id | free | "*) ;; *) fail "$id: no free row: $row" ;; esac
    if install_unspawnable_for "$W" "$id"; then
      part="| install failed: $INSTALL_SPAWN_ERROR; log $W/handoff/ghost-$id.install.log | "
      echo "$row" | grep -qF -- "$part" || fail "$id: the free row lacks '$part': $row"
      continue
    fi
    if session_unspawnable_for "$W" "$id"; then
      part="| session failed: $SESSION_SPAWN_ERROR | "
      echo "$row" | grep -qF -- "$part" || fail "$id: the free row lacks '$part': $row"
      continue
    fi
    if install_fails_for "$W" "$id"; then
      for part in 'install failed: exit 1' "log $W/handoff/ghost-$id.install.log"; do
        echo "$row" | grep -qF -- "$part" || fail "$id: the free row lacks '$part': $row"
      done
      ! echo "$row" | grep -qF 'session ' || fail "$id: the free row names a session although none started: $row"
      continue
    fi
    part="exit $(expected_exit "$W" "$id"); $(expected_ladder "$W" "$id"); report $W/handoff/ghost-$id.jsonl; session $(session_of "$W" "$id")"
    echo "$row" | grep -qF -- "$part" || fail "$id: the free row lacks '$part': $row"
  done
}

check_install() {
  local W=$1 id wt dir
  for id in $(ids_of "$W"); do
    wt="$W/wt-$id"
    dir="$W/stub/wt-$id"
    if install_unspawnable_for "$W" "$id"; then
      [ ! -e "$W/bin/pnpm" ] || fail "the world is broken: $W/bin/pnpm exists in an install-unspawnable world"
      [ ! -e "$dir/argv" ] || fail "$id: a session started although its install could not be spawned"
      [ ! -e "$W/handoff/ghost-$id.jsonl" ] || fail "$id: a report exists although no session started"
      continue
    fi
    [ -f "$dir/pnpm-argv" ] || fail "$id: pnpm install did not run in $wt"
    read_argv "$dir/pnpm-argv"
    [ "${ARGV[*]}" = 'install --frozen-lockfile' ] || fail "$id: the install argv is '${ARGV[*]}', not 'install --frozen-lockfile'"
    [ "$(cat "$dir/pnpm-cwd")" = "$wt" ] || fail "$id: the install ran in $(cat "$dir/pnpm-cwd"), not $wt"
    if install_fails_for "$W" "$id"; then
      [ ! -e "$dir/argv" ] || fail "$id: a session started although its install failed"
      [ ! -e "$W/handoff/ghost-$id.jsonl" ] || fail "$id: a report exists although no session started"
      [ -f "$W/handoff/ghost-$id.install.log" ] || fail "$id: no install log $W/handoff/ghost-$id.install.log"
      grep -qF 'stub install failed: lockfile out of date' "$W/handoff/ghost-$id.install.log" || fail "$id: the install log lacks the install's stderr"
      grep -qF "stub install in wt-$id" "$W/handoff/ghost-$id.install.log" || fail "$id: the install log lacks the install's stdout"
    elif session_unspawnable_for "$W" "$id"; then
      [ ! -e "$W/bin/claude" ] || fail "the world is broken: $W/bin/claude still exists after the install of $id"
      [ ! -e "$dir/argv" ] || fail "$id: a session ran although claude could not be spawned"
    else
      [ -f "$dir/installed-at-start" ] || fail "$id: the session did not start"
      [ "$(cat "$dir/installed-at-start")" = yes ] || fail "$id: the session started before the install finished"
    fi
  done
}

check_journal() {
  local W=$1 sha
  sha=$(origin_sha "$W")
  local pairs='' id
  for id in $(ids_of "$W"); do
    pairs="$pairs $id=$(session_of_or_null "$W" "$id")=$(approved_sha "$W/handoff/brief-$id.approved-sha256")=$(args_broken_for "$W" "$id" && echo broken || echo tied)"
  done
  node - "$W" "$sha" "$(kind_of "$W")" "$(cat "$W/.world/sketch-tip" 2>/dev/null || true)" "$ARGS_PATH" $pairs <<'EOF' || fail "$(cat "$W/.world/journal-failure" 2>/dev/null)"
const fs = require('node:fs')
const crypto = require('node:crypto')
const [W, sha, kind, sketchTip, argsPath, ...pairs] = process.argv.slice(2)
const tasks = pairs.map(pair => pair.split('='))
const failWith = (message) => { fs.writeFileSync(`${W}/.world/journal-failure`, message); process.exit(1) }
const journal = `${W}/handoff/ghosts.jsonl`
if (!fs.existsSync(journal)) failWith(`no ${journal}`)
for (const inRepo of [`${W}/main/.construct/ghosts.jsonl`, `${W}/wt-g1/.construct/ghosts.jsonl`, `${W}/wt-g2/.construct/ghosts.jsonl`])
  if (fs.existsSync(inRepo)) failWith(`the journal is written inside a repository: ${inRepo}`)
const seedFile = `${W}/.world/ghosts.jsonl`
const seed = fs.existsSync(seedFile) ? fs.readFileSync(seedFile, 'utf8') : ''
const text = fs.readFileSync(journal, 'utf8')
if (!text.startsWith(seed)) failWith(`${journal} does not start with the lines it held before the launch, byte for byte`)
const seedLines = seed.split('\n').filter(line => line !== '').length
const lines = text.split('\n').filter(line => line !== '').slice(seedLines)
if (lines.length !== tasks.length) failWith(`${lines.length} lines appended to ${journal}, not ${tasks.length}`)
const rows = lines.map((line, index) => { try { return JSON.parse(line) } catch { failWith(`line ${index + 1} of ${journal} is not JSON`) } })
const KEYS = ['event', 'ts', 'task', 'session', 'baseSha', 'sketch', 'install', 'exit', 'ladder', 'run', 'iterations', 'class', 'contour', 'resultLine', 'total_cost_usd', 'num_turns', 'duration_ms', 'usage', 'review', 'agreedSha256', 'argsSha256', 'expected', 'actual']
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const matrix = JSON.parse(fs.readFileSync(`${W}/matrix.json`, 'utf8'))
for (const [id, session, approved, link] of tasks) {
  const found = rows.filter(row => row.task === id)
  if (found.length !== 1) failWith(`${found.length} journal lines for task ${id}, not 1`)
  const row = found[0]
  const keys = Object.keys(row).sort().join(',')
  if (keys !== [...KEYS].sort().join(',')) failWith(`${id}: the keys are ${keys}, not ${[...KEYS].sort().join(',')}`)
  const installFailed = kind === 'install-fails' && id === 'g2'
  const installUnspawnable = kind === 'install-unspawnable'
  const sessionUnspawnable = kind === 'session-unspawnable' && id === 'g2'
  const noSession = installFailed || installUnspawnable || sessionUnspawnable
  const noLadder = noSession || (kind === 'no-ladder' && id === 'g2')
  const noResult = noSession || (kind === 'no-result' && id === 'g2')
  const matrixKey = /^[0-9]+$/.test(id) ? `#${id}` : id
  const matrixRow = kind === 'with-matrix' || kind === 'numeric-id' ? matrix.rows.find(r => r.task === matrixKey) : undefined
  const result = noResult ? null : JSON.parse(fs.readFileSync(`${W}/.world/result-${id}.json`, 'utf8'))
  if (typeof row.ts !== 'string' || !ISO_Z.test(row.ts)) failWith(`${id}: ts is ${JSON.stringify(row.ts)}, not an ISO time ending in Z`)
  const want = {
    event: 'task',
    ts: row.ts,
    task: id,
    session: noSession ? null : session,
    baseSha: sha,
    sketch: kind === 'sketch' && id === 'g2' ? sketchTip : null,
    install: installFailed ? 1 : (installUnspawnable ? null : 0),
    exit: noSession ? null : (kind === 'failing' && id === 'g2' ? 3 : 0),
    ladder: noLadder ? 'no ladder run' : (kind === 'failing' && id === 'g2' ? 'failed' : 'done'),
    run: noLadder ? null : `run-${id}`,
    iterations: noLadder ? null : (id === 'g1' ? 2 : 1),
    class: matrixRow ? matrixRow.class : null,
    contour: matrixRow ? matrixRow.contour : null,
    resultLine: noResult ? 'missing' : 'present',
    total_cost_usd: result ? result.total_cost_usd : null,
    num_turns: result ? result.num_turns : null,
    duration_ms: noSession ? null : 430500,
    usage: result ? result.usage : null,
    review: null,
    agreedSha256: approved,
    expected: id !== 'g2' ? null : kind === 'expect' ? { kind: 'forecast', tokens: 166000, minutes: 12, basis: { effort: 'medium', n: 61 } } : kind === 'expect-none' ? { kind: 'none', reason: 'n=3 for effort low' } : null,
    actual: noLadder ? null : { tokens: 100, minutes: 10 / 60 },
    argsSha256: noLadder || link === 'broken' ? null : crypto.createHash('sha256').update(fs.readFileSync(`${W}/wt-${id}/${argsPath}`)).digest('hex'),
  }
  for (const key of KEYS) {
    if (JSON.stringify(row[key]) !== JSON.stringify(want[key]))
      failWith(`${id}: ${key} is ${JSON.stringify(row[key])}, not ${JSON.stringify(want[key])}`)
  }
}
EOF
}

args_broken_for() {
  [ "$2" = g2 ] && case " $ARGS_BROKEN_KINDS " in *" $(kind_of "$1") "*) true ;; *) false ;; esac
}

check_args() {
  local W=$1 id link
  for id in $(ids_of "$W"); do
    if args_broken_for "$W" "$id"; then link=$(kind_of "$W"); else link=tied; fi
    node - "$W" "$id" "$(approved_sha "$W/handoff/brief-$id.approved-sha256")" "$link" "$ARGS_PATH" <<'EOF' || fail "$(cat "$W/.world/args-failure" 2>/dev/null)"
const fs = require('node:fs')
const crypto = require('node:crypto')
const [W, id, approved, link, argsPath] = process.argv.slice(2)
const failWith = (message) => { fs.writeFileSync(`${W}/.world/args-failure`, `${id}: ${message}`); process.exit(1) }
const argsFile = `${W}/wt-${id}/${argsPath}`
const handleFile = `${W}/stub/wt-${id}/handle`
if (!fs.existsSync(argsFile)) failWith(`no ${argsFile}`)
if (!fs.existsSync(handleFile)) failWith(`the stub printed no handle at ${handleFile}`)
const bytes = fs.readFileSync(argsFile)
const fileSha = crypto.createHash('sha256').update(bytes).digest('hex')
const args = JSON.parse(bytes.toString('utf8'))
const handle = JSON.parse(fs.readFileSync(handleFile, 'utf8'))
const row = JSON.parse(fs.readFileSync(`${W}/wt-${id}/.construct/runs.jsonl`, 'utf8').split('\n').filter(line => line !== '').at(-1))
if (row.run !== `run-${id}`) failWith(`the last ledger row is ${row.run}, not run-${id}`)
if ((args.agreedSha256 === approved) === (link === 'args-elsewhere'))
  failWith(`the args file's agreedSha256 is ${args.agreedSha256} and the approved hash ${approved}; the link is ${link}`)
if ((handle.argsSha256 === fileSha) === (link === 'args-rewritten'))
  failWith(`the handle's argsSha256 is ${handle.argsSha256} and the file's bytes hash to ${fileSha}; the link is ${link}`)
if (link === 'row-without-hashes') {
  if ('agreedSha256' in row || 'argsSha256' in row)
    failWith(`the row carries a hash; the link is ${link}`)
}
else if (row.agreedSha256 !== handle.agreedSha256 || row.argsSha256 !== handle.argsSha256) {
  failWith(`the row's hashes ${row.agreedSha256} ${row.argsSha256} are not the handle's ${handle.agreedSha256} ${handle.argsSha256}`)
}
EOF
  done
}

check_summary() {
  local W=$1 id lines want
  for id in $(ids_of "$W"); do
    lines=$(grep -E "^$id: " "$W/launch.out" || true)
    [ -n "$lines" ] || fail "$id: launch.out has no line starting '$id: '"
    [ "$(echo "$lines" | wc -l | tr -d ' ')" = 1 ] || fail "$id: launch.out has more than one line starting '$id: ': $lines"
    want=$(expected_outcome "$W" "$id")
    echo "$lines" | grep -qF -- "$want" || fail "$id: the launcher's line lacks '$want': $lines"
  done
}

session_of_or_null() {
  if [ -f "$1/stub/wt-$2/argv" ]; then session_of "$1" "$2"; else echo null; fi
}

CHECK=${1:-}
case $CHECK in
  new) new_world "${2:?usage: world.sh new <$KINDS>}" ;;
  clean)
    W=${2:?usage: world.sh clean <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    remove_world "$W"
    ;;
  check-decision | check-untouched | check-refused | check-sketch | check-launched | check-rows | check-report | check-ladder | check-install | check-journal | check-summary | check-args)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    fn=${CHECK#check-}
    "check_$fn" "$W"
    ;;
  *) echo "usage: world.sh new <${KINDS// /|}> | world.sh clean <world> | world.sh check-<decision|untouched|refused|sketch|launched|rows|report|ladder|install|journal|summary|args> <world>" >&2; exit 2 ;;
esac
