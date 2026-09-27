#!/usr/bin/env bash
set -euo pipefail

KINDS='ok tampered unapproved failing occupied with-matrix no-ladder no-result install-fails trailing-newline'
FAILING_EXIT=3

fail() {
  echo "world.sh $CHECK: $*" >&2
  exit 1
}

git_quiet() {
  git -c user.name=world -c user.email=world@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main "$@" >/dev/null 2>&1
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

write_brief() {
  local W=$1 id=$2 text
  cat >"$W/handoff/brief-$id.md" <<EOF
# Brief $id (world fixture)

The header is not part of the approved text; the text below is sent as /implement to the session.

---

/implement Ghost $id: print \`hello $id\` with "double" and 'single' quotes; it's fine.

Design:
- A line with a backslash \\ and a dollar \$HOME that must stay literal.

Acceptance: the ghost prints hello — witness: \`echo "hello $id"\`
EOF
  text=$(cat "$W/handoff/brief-$id.md")
  printf '%s' "$text" >"$W/handoff/brief-$id.md"
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

write_results() {
  local W=$1
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":9.99,"num_turns":99,"duration_ms":99999,"usage":{"input_tokens":999,"output_tokens":999}}' >"$W/.world/result-g1-early.json"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.5,"num_turns":7,"duration_ms":1000,"usage":{"input_tokens":11,"output_tokens":22,"cache_read_input_tokens":33}}' >"$W/.world/result-g1.json"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.25,"num_turns":3,"duration_ms":500,"usage":{"input_tokens":44,"output_tokens":55}}' >"$W/.world/result-g2.json"
}

write_stub() {
  local W=$1
  printf '#!/usr/bin/env bash\nset -euo pipefail\nW=%q\nFAILING_EXIT=%q\n' "$W" "$FAILING_EXIT" >"$W/bin/claude"
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
: >"$dir/stdout"
emit() { printf '%s\n' "$1" >>"$dir/stdout"; printf '%s\n' "$1"; }
emit "{\"type\":\"system\",\"subtype\":\"init\",\"ghost\":\"$ghost\"}"
[ "$id" = g1 ] && emit "$(cat "$W/.world/result-g1-early.json")"
emit "{\"type\":\"assistant\",\"ghost\":\"$ghost\"}"
status=done
[ "$kind" = failing ] && [ "$id" = g2 ] && status=failed
[ "$kind" = no-ladder ] && [ "$id" = g2 ] && status=none
if [ "$status" != none ]; then
  attempts='[{"rung":"low","outcome":"done"}]'
  [ "$id" = g1 ] && attempts='[{"rung":"low","outcome":"harness failed"},{"rung":"medium","outcome":"done"}]'
  printf '{"run":"run-%s","at":"2026-09-27T20:00:00.000Z","task":"Ghost %s","effort":"low","status":"%s","rung":"low","attempts":%s}\n' "$id" "$id" "$status" "$attempts" >>"$PWD/.construct/runs.jsonl"
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

write_tasks() {
  local W=$1 kind=$2 matrix=''
  [ "$kind" = with-matrix ] && matrix="\"matrix\": \"$W/matrix.json\", "
  cat >"$W/tasks.json" <<EOF
{ "repo": "$W/main", "status": "$W/handoff/status.md", "out": "$W/handoff", $matrix"tasks": [
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
  mkdir -p "$W/.world/seed/.construct"
  printf '%s\n' '{"run":"run-old","at":"2026-09-26T10:00:00.000Z","task":"an earlier run","effort":"low","status":"done","rung":"low","attempts":[{"rung":"low","outcome":"done"}]}' >"$W/.world/seed/.construct/runs.jsonl"
  git_quiet -C "$W/.world/seed" add file.txt .construct/runs.jsonl
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
    trailing-newline) printf '\n\n\n' >>"$W/handoff/brief-g2.md" ;;
  esac
  echo "$kind" >"$W/.world/kind"
  write_status "$W" "$kind"
  write_results "$W"
  write_stub "$W"
  write_matrix "$W"
  write_tasks "$W" "$kind"

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
  for id in g1 g2; do
    row=$(grep -F "| ghost-$id |" "$W/handoff/status.md" || true)
    case $row in "| ghost-$id | $W/wt-$id | free | "*) ;; *) fail "$id: no free row: $row" ;; esac
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
  for id in g1 g2; do
    wt="$W/wt-$id"
    dir="$W/stub/wt-$id"
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
    else
      [ -f "$dir/installed-at-start" ] || fail "$id: the session did not start"
      [ "$(cat "$dir/installed-at-start")" = yes ] || fail "$id: the session started before the install finished"
    fi
  done
}

check_journal() {
  local W=$1 sha
  sha=$(origin_sha "$W")
  node - "$W" "$sha" "$(kind_of "$W")" "$(session_of_or_null "$W" g1)" "$(session_of_or_null "$W" g2)" <<'EOF' || fail "$(cat "$W/.world/journal-failure" 2>/dev/null)"
const fs = require('node:fs')
const [W, sha, kind, s1, s2] = process.argv.slice(2)
const failWith = (message) => { fs.writeFileSync(`${W}/.world/journal-failure`, message); process.exit(1) }
const journal = `${W}/handoff/ghosts.jsonl`
if (!fs.existsSync(journal)) failWith(`no ${journal}`)
for (const inRepo of [`${W}/main/.construct/ghosts.jsonl`, `${W}/wt-g1/.construct/ghosts.jsonl`, `${W}/wt-g2/.construct/ghosts.jsonl`])
  if (fs.existsSync(inRepo)) failWith(`the journal is written inside a repository: ${inRepo}`)
const lines = fs.readFileSync(journal, 'utf8').split('\n').filter(line => line !== '')
if (lines.length !== 2) failWith(`${lines.length} lines in ${journal}, not 2`)
const rows = lines.map((line, index) => { try { return JSON.parse(line) } catch { failWith(`line ${index + 1} of ${journal} is not JSON`) } })
const KEYS = ['event', 'ts', 'task', 'session', 'baseSha', 'install', 'exit', 'ladder', 'run', 'iterations', 'class', 'contour', 'resultLine', 'total_cost_usd', 'num_turns', 'duration_ms', 'usage', 'review']
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const matrix = JSON.parse(fs.readFileSync(`${W}/matrix.json`, 'utf8'))
for (const [id, session] of [['g1', s1], ['g2', s2]]) {
  const found = rows.filter(row => row.task === id)
  if (found.length !== 1) failWith(`${found.length} journal lines for task ${id}, not 1`)
  const row = found[0]
  const keys = Object.keys(row).sort().join(',')
  if (keys !== [...KEYS].sort().join(',')) failWith(`${id}: the keys are ${keys}, not ${[...KEYS].sort().join(',')}`)
  const installFailed = kind === 'install-fails' && id === 'g2'
  const noLadder = installFailed || (kind === 'no-ladder' && id === 'g2')
  const noResult = installFailed || (kind === 'no-result' && id === 'g2')
  const matrixRow = kind === 'with-matrix' ? matrix.rows.find(r => r.task === id) : undefined
  const result = noResult ? null : JSON.parse(fs.readFileSync(`${W}/.world/result-${id}.json`, 'utf8'))
  if (typeof row.ts !== 'string' || !ISO_Z.test(row.ts)) failWith(`${id}: ts is ${JSON.stringify(row.ts)}, not an ISO time ending in Z`)
  const want = {
    event: 'task',
    ts: row.ts,
    task: id,
    session: installFailed ? null : session,
    baseSha: sha,
    install: installFailed ? 1 : 0,
    exit: installFailed ? null : (kind === 'failing' && id === 'g2' ? 3 : 0),
    ladder: noLadder ? 'no ladder run' : (kind === 'failing' && id === 'g2' ? 'failed' : 'done'),
    run: noLadder ? null : `run-${id}`,
    iterations: noLadder ? null : (id === 'g1' ? 2 : 1),
    class: matrixRow ? matrixRow.class : null,
    contour: matrixRow ? matrixRow.contour : null,
    resultLine: noResult ? 'missing' : 'present',
    total_cost_usd: result ? result.total_cost_usd : null,
    num_turns: result ? result.num_turns : null,
    duration_ms: result ? result.duration_ms : null,
    usage: result ? result.usage : null,
    review: null,
  }
  for (const key of KEYS) {
    if (JSON.stringify(row[key]) !== JSON.stringify(want[key]))
      failWith(`${id}: ${key} is ${JSON.stringify(row[key])}, not ${JSON.stringify(want[key])}`)
  }
}
EOF
}

session_of_or_null() {
  if [ -f "$1/stub/wt-$2/argv" ]; then session_of "$1" "$2"; else echo null; fi
}

CHECK=${1:-}
case $CHECK in
  new) new_world "${2:?usage: world.sh new <$KINDS>}" ;;
  check-decision | check-untouched | check-refused | check-launched | check-rows | check-report | check-ladder | check-install | check-journal)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    fn=${CHECK#check-}
    "check_$fn" "$W"
    ;;
  *) echo "usage: world.sh new <${KINDS// /|}> | world.sh check-<decision|untouched|refused|launched|rows|report|ladder|install|journal> <world>" >&2; exit 2 ;;
esac
