#!/usr/bin/env bash
set -euo pipefail

KINDS='base stale alive no-ledger no-tool no-report near-tool far-tool no-row'
TAIL_BYTES=262144
STALE_SECONDS=7200
STUB_SECONDS=300
FILLER_LINES=300

fail() {
  echo "watch world.sh $CHECK: $*" >&2
  exit 1
}

new_uuid() {
  node -e 'console.log(require("node:crypto").randomUUID())'
}

touch_stamp() {
  node -e 'const d=new Date(Date.now()-Number(process.argv[1])*1000);const p=n=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}.${p(d.getSeconds())}`)' "$1"
}

filler() {
  local pad i
  pad=$(printf '%01000d' 0 | tr 0 x)
  i=0
  while [ "$i" -lt "$FILLER_LINES" ]; do
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"filler %s %s"}]}}\n' "$i" "$pad"
    i=$((i + 1))
  done
}

tool_use_line() {
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"calling %s"},{"type":"tool_use","id":"toolu_%s","name":"%s","input":{"command":"SECRET-INPUT-%s"}}]},"session_id":"%s"}\n' "$1" "$1" "$1" "$1" "$2"
}

tool_result_line() {
  printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%s","content":"SECRET-RESULT-%s"}]},"session_id":"%s"}\n' "$1" "$1" "$2"
}

init_line() {
  printf '{"type":"system","subtype":"init","session_id":"%s","tools":["Read","Grep","Edit"]}\n' "$1"
}

write_report() {
  local W=$1 kind=$2 s1 report
  s1=$(cat "$W/.world/session-g1")
  report="$W/handoff/ghost-g1.jsonl"
  case $kind in
    no-report) return 0 ;;
    no-tool)
      {
        init_line "$s1"
        printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SECRET-TEXT thinking, no tool yet"}]},"session_id":"%s"}\n' "$s1"
      } >"$report"
      ;;
    near-tool)
      {
        init_line "$s1"
        filler
        tool_use_line Edit "$s1"
        tool_result_line Edit "$s1"
        printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SECRET-TEXT after the edit"}]},"session_id":"%s"}\n' "$s1"
      } >"$report"
      ;;
    far-tool)
      {
        init_line "$s1"
        tool_use_line Edit "$s1"
        tool_result_line Edit "$s1"
        filler
      } >"$report"
      ;;
    *)
      {
        init_line "$s1"
        tool_use_line Read "$s1"
        tool_result_line Read "$s1"
        tool_use_line Grep "$s1"
        tool_result_line Grep "$s1"
        printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SECRET-TEXT reading the result"}]},"session_id":"%s"}\n' "$s1"
        printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_Half","name":"Wri'
      } >"$report"
      ;;
  esac
  if [ "$kind" = stale ]; then
    touch -t "$(touch_stamp "$STALE_SECONDS")" "$report"
  fi
}

check_tail_layout() {
  local W=$1 kind=$2 report size before
  report="$W/handoff/ghost-g1.jsonl"
  case $kind in
    near-tool|far-tool) ;;
    *) return 0 ;;
  esac
  size=$(wc -c <"$report" | tr -d ' ')
  [ "$size" -gt "$TAIL_BYTES" ] || { echo "world.sh new: the $kind report is $size bytes, not more than $TAIL_BYTES" >&2; exit 2; }
  before=$(awk '/"name":"Edit"/ { print total + length($0) + 1; exit } { total += length($0) + 1 }' "$report")
  if [ "$kind" = far-tool ]; then
    [ "$((size - before))" -gt "$TAIL_BYTES" ] || { echo "world.sh new: the far-tool Edit line ends inside the last $TAIL_BYTES bytes" >&2; exit 2; }
  else
    [ "$((size - before))" -lt "$TAIL_BYTES" ] || { echo "world.sh new: the near-tool Edit line is not inside the last $TAIL_BYTES bytes" >&2; exit 2; }
  fi
}

write_ledgers() {
  local W=$1 kind=$2
  mkdir -p "$W/wt-g1/.construct" "$W/wt-g2/.construct"
  : >"$W/wt-g2/.construct/runs.jsonl"
  [ "$kind" = no-ledger ] && return 0
  {
    printf '%s\n' '{"run":"run-old","at":"2026-09-26T10:00:00.000Z","task":"an earlier run","effort":"low","status":"done","rung":"low","attempts":[{"rung":"low","outcome":"done"}]}'
    printf '%s\n' '{"run":"run-g1","at":"2026-09-28T10:00:00.000Z","task":"Ghost g1","effort":"medium","status":"failed","rung":"medium","attempts":[{"rung":"low","outcome":"harness failed"},{"rung":"medium","outcome":"failed"}]}'
  } >"$W/wt-g1/.construct/runs.jsonl"
}

write_status() {
  local W=$1 kind=$2 base=0123456789abcdef0123456789abcdef01234567
  {
    cat <<'EOF'
# Ghosts — window status

Machine-readable. One row per window.

| window | tree | state | sha | task start | waits for | updated |
|---|---|---|---|---|---|---|
| A | — | free | bc27f2c | — | window B's ladder | 2026-09-27 21:26 |
EOF
    printf '| ghost-g1x | %s | writing | %s | 2026-09-28 09:00 | /implement brief-g1x.md, session %s | 2026-09-28 09:00 |\n' "$W/wt-g1x" "$base" "$(cat "$W/.world/session-g1x")"
    if [ "$kind" != no-row ]; then
      printf '| ghost-g1 | %s | writing | %s | 2026-09-28 10:00 | /implement brief-g1.md, session %s | 2026-09-28 10:00 |\n' "$W/wt-g1" "$base" "$(cat "$W/.world/session-g1")"
    fi
    printf '| ghost-g2 | %s | free | %s | 2026-09-28 10:00 | exit 1; ladder failed; report %s; session %s | 2026-09-28 10:05 |\n' "$W/wt-g2" "$base" "$W/handoff/ghost-g2.jsonl" "$(cat "$W/.world/session-g2")"
    cat <<'EOF'

| policy | value | set by | updated |
|---|---|---|---|
| release-gate | the next release follows the merge of the whole chain | Eli | 2026-09-27 20:41 |
EOF
  } >"$W/handoff/status.md"
}

write_tasks() {
  local W=$1
  cat >"$W/tasks.json" <<EOF
{ "repo": "$W/repo", "status": "$W/handoff/status.md", "out": "$W/handoff", "tasks": [
  { "id": "g1", "brief": "$W/handoff/brief-g1.md", "worktree": "$W/wt-g1", "branch": "ghost/g1" },
  { "id": "g2", "brief": "$W/handoff/brief-g2.md", "worktree": "$W/wt-g2", "branch": "ghost/g2" }
] }
EOF
  cat >"$W/tasks-bogus.json" <<EOF
{ "repo": "$W/repo", "status": "$W/handoff/status.md", "out": "$W/handoff", "bogus": true, "tasks": [
  { "id": "g1", "brief": "$W/handoff/brief-g1.md", "worktree": "$W/wt-g1", "branch": "ghost/g1" }
] }
EOF
}

start_stub() {
  local W=$1 session pid i
  session=$(cat "$W/.world/session-g1")
  cat >"$W/bin/claude" <<EOF
#!/usr/bin/env bash
trap 'kill "\$child" 2>/dev/null; exit 0' TERM INT
sleep $STUB_SECONDS &
child=\$!
wait "\$child"
EOF
  chmod +x "$W/bin/claude"
  "$W/bin/claude" -p --output-format stream-json --verbose --session-id "$session" '/implement world stub' </dev/null >/dev/null 2>&1 &
  pid=$!
  echo "$pid" >>"$W/.world/pids"
  i=0
  while [ "$i" -lt 50 ]; do
    case "$(ps -p "$pid" -o args= 2>/dev/null || true)" in *"--session-id $session"*) return 0 ;; esac
    sleep 0.1
    i=$((i + 1))
  done
  echo "world.sh new: the stub process $pid never showed --session-id $session" >&2
  exit 2
}

snapshot() {
  node - "$1" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const W = process.argv[2]
const skip = new Set(['.world', 'watch.out', 'watch.err'])
const entries = {}
const walk = (relative) => {
  for (const name of fs.readdirSync(path.join(W, relative)).sort()) {
    const rel = relative ? `${relative}/${name}` : name
    if (relative === '' && skip.has(name)) continue
    const stat = fs.lstatSync(path.join(W, rel))
    if (stat.isDirectory()) { entries[rel] = 'dir'; walk(rel); continue }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(W, rel))).digest('hex')
    entries[rel] = `${sha} ${stat.mtimeMs}`
  }
}
walk('')
process.stdout.write(`${JSON.stringify(entries, null, 1)}\n`)
EOF
}

new_world() {
  local kind=$1 W id
  case " $KINDS " in *" $kind "*) ;; *) echo "world.sh new: unknown kind '$kind' (one of: $KINDS)" >&2; exit 2 ;; esac
  W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/watch-world.XXXXXX")" && pwd -P)
  mkdir -p "$W/.world" "$W/handoff" "$W/bin" "$W/repo" "$W/wt-g1" "$W/wt-g2"
  echo "$kind" >"$W/.world/kind"
  : >"$W/.world/pids"
  for id in g1 g2 g1x; do new_uuid >"$W/.world/session-$id"; done
  for id in g1 g2; do printf '# brief %s\n\n---\n\n/implement Ghost %s' "$id" "$id" >"$W/handoff/brief-$id.md"; done
  write_tasks "$W"
  write_status "$W" "$kind"
  write_ledgers "$W" "$kind"
  write_report "$W" "$kind"
  check_tail_layout "$W" "$kind"
  [ "$kind" = alive ] && start_stub "$W"
  snapshot "$W" >"$W/.world/snapshot.json"
  echo "$W"
}

stop_stubs() {
  local W=$1 pid
  [ -f "$W/.world/pids" ] || return 0
  while IFS= read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done <"$W/.world/pids"
  : >"$W/.world/pids"
}

run_for() {
  local W=$1 seconds=$2
  shift 2
  node - "$W" "$seconds" "$@" <<'EOF'
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const [W, seconds, command, ...args] = process.argv.slice(2)
const out = fs.openSync(`${W}/watch.out`, 'w')
const err = fs.openSync(`${W}/watch.err`, 'w')
const record = (value) => fs.writeFileSync(`${W}/.world/run-exit`, `${value}\n`)
const child = spawn(command, args, { detached: true, stdio: ['ignore', out, err] })
let killed = false
const timer = setTimeout(() => {
  killed = true
  record('killed')
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
}, Number(seconds) * 1000)
child.on('error', (error) => { clearTimeout(timer); record(`error ${error.message}`); process.exit(0) })
child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (!killed) {
    record(code === null ? `signal ${signal}` : String(code))
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  process.exit(0)
})
EOF
}

expected_g1() {
  case $1 in
    no-report) echo 'no report|tool none|stage failed run-g1|process dead' ;;
    no-tool|far-tool) echo 'age|tool none|stage failed run-g1|process dead' ;;
    near-tool) echo 'age|tool Edit|stage failed run-g1|process dead' ;;
    no-ledger) echo 'age|tool Grep|stage no ledger lines|process dead' ;;
    alive) echo 'age|tool Grep|stage failed run-g1|process alive' ;;
    no-row) echo 'age|tool Grep|stage failed run-g1|process no session' ;;
    *) echo 'age|tool Grep|stage failed run-g1|process dead' ;;
  esac
}

check_frames() {
  local W=$1 mode=$2 kind
  kind=$(cat "$W/.world/kind")
  [ -f "$W/.world/run-exit" ] || fail "the watch was not run through run-for (no $W/.world/run-exit)"
  node - "$W" "$mode" "$(expected_g1 "$kind")" <<'EOF' || fail "$(cat "$W/.world/check-failure" 2>/dev/null)"
const fs = require('node:fs')
const [W, mode, g1Spec] = process.argv.slice(2)
const failWith = (message) => { fs.writeFileSync(`${W}/.world/check-failure`, message); process.exit(1) }
const exit = fs.readFileSync(`${W}/.world/run-exit`, 'utf8').trim()
const stdout = fs.readFileSync(`${W}/watch.out`, 'utf8')
const stderr = fs.readFileSync(`${W}/watch.err`, 'utf8')
if (mode === 'once' && exit !== '0') failWith(`the watch exited '${exit}', not 0 within the deadline; stderr: ${stderr.slice(0, 400)}`)
if (mode === 'every' && exit !== 'killed') failWith(`with --every the watch ended by itself ('${exit}') instead of redrawing until stopped; stderr: ${stderr.slice(0, 400)}`)
if (stdout.includes('\u001b')) failWith('stdout contains an escape sequence')
for (const text of [stdout, stderr]) {
  if (text.includes('SECRET-')) failWith(`the output shows report content: ${text.slice(text.indexOf('SECRET-'), text.indexOf('SECRET-') + 40)}`)
}
const header = /^ghosts:watch \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
const lines = stdout.split('\n')
if (lines.at(-1) === '') lines.pop()
const frames = []
for (const line of lines) {
  if (header.test(line)) { frames.push([]); continue }
  if (frames.length === 0) failWith(`a line before the first frame header: ${line}`)
  frames.at(-1).push(line)
}
const reportPath = `${W}/handoff/ghost-g1.jsonl`
const nowMs = Date.now()
const expected = {
  g1: g1Spec.split('|'),
  g2: ['no report', 'tool none', 'stage no ledger lines', 'process dead'],
}
const checkRow = (row, id) => {
  const fields = row.split(' | ')
  if (fields.length !== 5 || fields[0] !== `ghost-${id}`) failWith(`not a line 'ghost-${id} | report | tool | stage | process': ${row}`)
  const want = expected[id]
  if (want[0] === 'age') {
    const match = /^report (\d+)s$/.exec(fields[1])
    if (!match) failWith(`ghost-${id}: '${fields[1]}' is not 'report <n>s'`)
    const upper = (nowMs - fs.statSync(reportPath).mtimeMs) / 1000
    const age = Number(match[1])
    if (age > upper + 1 || age < upper - 90) failWith(`ghost-${id}: report age ${age}s, but the report was written ${Math.floor(upper)}s before this check`)
  }
  else if (fields[1] !== want[0]) failWith(`ghost-${id}: '${fields[1]}', not '${want[0]}'`)
  for (let i = 1; i < 4; i += 1) {
    if (fields[i + 1] !== want[i]) failWith(`ghost-${id}: '${fields[i + 1]}', not '${want[i]}'`)
  }
}
const complete = frames.filter(rows => rows.length === 2)
frames.forEach((rows, index) => {
  const last = index === frames.length - 1
  if (rows.length > 2 || (rows.length < 2 && (mode === 'once' || !last))) failWith(`frame ${index + 1} has ${rows.length} task lines, not 2: ${rows.join(' / ')}`)
})
for (const rows of complete) { checkRow(rows[0], 'g1'); checkRow(rows[1], 'g2') }
if (mode === 'once' && frames.length !== 1) failWith(`${frames.length} frames printed, not exactly 1`)
if (mode === 'every' && complete.length < 2) failWith(`${complete.length} complete frames printed with --every, not at least 2`)
EOF
}

check_readonly() {
  local W=$1
  [ -f "$W/.world/run-exit" ] || fail "the watch was not run through run-for (no $W/.world/run-exit)"
  grep -q '^ghost-g1 | ' "$W/watch.out" || fail "no ghost-g1 line in the watch output, so nothing was read"
  snapshot "$W" >"$W/.world/snapshot-after.json"
  if ! cmp -s "$W/.world/snapshot.json" "$W/.world/snapshot-after.json"; then
    fail "the world changed while the watch ran: $(diff "$W/.world/snapshot.json" "$W/.world/snapshot-after.json" | grep '^[<>]' | tr '\n' ' ' | cut -c1-600)"
  fi
}

check_refused() {
  local W=$1 word=$2 exit
  [ -f "$W/.world/run-exit" ] || fail "the watch was not run through run-for (no $W/.world/run-exit)"
  exit=$(cat "$W/.world/run-exit")
  case $exit in
    0|killed|signal*|error*) fail "the watch was not refused: run-exit '$exit'" ;;
  esac
  if grep -Eq '^(ghosts:watch |ghost-)' "$W/watch.out"; then fail "a refused watch printed a frame: $(head -n 3 "$W/watch.out" | tr '\n' ' ')"; fi
  grep -qF -- "$word" "$W/watch.err" || fail "the refusal does not name '$word': $(head -c 400 "$W/watch.err")"
}

CHECK=${1:-}
WORLD=${2:-}
case $CHECK in
  new) new_world "${2:?kind}" ;;
  kinds) echo "$KINDS" ;;
  run-for) shift; run_for "$@" ;;
  stop) stop_stubs "${2:?world}" ;;
  check-once) trap 'stop_stubs "$WORLD"' EXIT; check_frames "${2:?world}" once ;;
  check-every) trap 'stop_stubs "$WORLD"' EXIT; check_frames "${2:?world}" every ;;
  check-readonly) trap 'stop_stubs "$WORLD"' EXIT; check_readonly "${2:?world}" ;;
  check-refused) trap 'stop_stubs "$WORLD"' EXIT; check_refused "${2:?world}" "${3:?word}" ;;
  *) echo "usage: world.sh new <kind> | kinds | run-for <world> <seconds> <command...> | stop <world> | check-once <world> | check-every <world> | check-readonly <world> | check-refused <world> <word>" >&2; exit 2 ;;
esac