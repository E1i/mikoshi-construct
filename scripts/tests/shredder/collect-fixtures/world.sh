#!/usr/bin/env bash
set -euo pipefail

KINDS='ok occupied-out gh-pr-fails gh-issue-fails gh-run-fails unknown-task-field missing-top-field unknown-top-field missing-task-field git-fails task-brief-and-issue task-worktree-on-issue task-wrong-type top-wrong-type many-prs out-appears large-output repo-missing gh-pr-garbled gh-issue-garbled gh-run-garbled empty-out-appears relative-paths'
DECOYS='faithful status-as-text owner-merges-as-text unnamed-gh-issue unnamed-gh-run leftover-on-failure lenient-missing-top lenient-missing-task lenient-unknown-task lenient-unknown-top'
HEAD_AWAITING=1111111111111111111111111111111111111111
HEAD_PASSED=2222222222222222222222222222222222222222
HEAD_OTHER=3333333333333333333333333333333333333333
NON_ASCII_PATH=$(printf 'docs/caf\303\251.md')
QUEUED_ROWS='a #271 b #280'
LARGE_TITLE_BYTES=2000000

fail() {
  echo "world.sh $CHECK: $*" >&2
  exit 1
}

git_quiet() {
  git -c user.name=world -c user.email=world@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main "$@" >/dev/null 2>&1
}

write_repo() {
  local W=$1
  mkdir -p "$W/repo/src" "$W/repo/tests" "$W/repo/docs"
  echo '# world' >"$W/repo/README.md"
  echo 'export const a = 1' >"$W/repo/src/a.ts"
  echo 'export const b = 2' >"$W/repo/src/b.ts"
  echo 'guide' >"$W/repo/docs/guide.md"
  echo 'accents' >"$W/repo/$NON_ASCII_PATH"
  echo 'test' >"$W/repo/tests/a.test.ts"
  git_quiet -C "$W/repo" init
  git_quiet -C "$W/repo" config core.quotePath true
  git_quiet -C "$W/repo" add README.md docs src tests
  git_quiet -C "$W/repo" commit -m world
  echo 'not tracked' >"$W/repo/untracked.txt"
}

write_handoff() {
  local W=$1
  mkdir -p "$W/handoff"
  cat >"$W/handoff/status.md" <<'EOF'
# Ghosts — window status

| window | tree | state | sha | task start | waits for | updated |
|---|---|---|---|---|---|---|
| A | — | free | 52b2aa1 | — | — | 2026-09-27 22:00 |
|  B  |   —   | free |  52b2aa1 | —  |   uneven   spaces | 2026-09-27 22:00 |

| policy | value | set by | updated |
|---|---|---|---|
| owner-merges | `owner-merges.md` next to this file | Eli | 2026-09-27 18:50 |
EOF
  cat >"$W/handoff/owner-merges.md" <<'EOF'
# Owner-merged kinds (data)

| kind | paths (globs) | what it covers | example |
|---|---|---|---|
| release | — (matched by title: «chore: version packages») | version pull requests | — |
| own-instructions | `.claude/**`, `scripts/construct/**` | the agent's own working instructions | — |
| new-write-path | — (not checked by paths: decided by the owner) | a new path that init or attach writes | — |
EOF
  printf 'Bytes that are not UTF-8: \377\376 end\n' >>"$W/handoff/status.md"
  printf 'Bytes that are not UTF-8: \377\376\300 end\n' >>"$W/handoff/owner-merges.md"
  cat >"$W/handoff/brief-a.md" <<'EOF'
# Brief a (world fixture)

This header is not part of the approved text and is never copied into a snapshot.
Design: a label in the header is not the brief's.
/implementation notes: this header line is not the /implement text.

---

/implement Task a changes src/a.ts.

Effort: low — one file; the design is written here.

Design:
- src/a.ts exports 3.

Acceptance: a exports 3 — witness: `grep -q 3 src/a.ts`
EOF
  cat >"$W/handoff/brief-b.md" <<'EOF'
/implement Task b changes src/b.ts.

Effort: low — one file; the design is written here.

Design:
- src/b.ts exports 4.

Acceptance: b exports 4 — witness: `grep -q 4 src/b.ts`
EOF
}

write_gh() {
  local W=$1 kind=$2
  mkdir -p "$W/bin"
  cat >"$W/bin/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
kind='$kind'
args=" \$* "
printf 'cwd=%s GH_REPO=%s\n' "\$(pwd -P)" "\${GH_REPO-}" >>'$W/.world/gh-calls.log'
arg_after() {
  local want=\$1 prev=
  shift
  for a in "\$@"; do
    [ "\$prev" = "\$want" ] && { echo "\$a"; return; }
    prev=\$a
  done
}
limit_or() {
  local given=\$1 a
  shift
  for a in "\$@"; do
    case \$a in --limit=*) given=\${a#--limit=} ;; esac
  done
  a=\$(arg_after --limit "\$@")
  [ -n "\$a" ] || a=\$(arg_after -L "\$@")
  echo "\${a:-\$given}"
}
json_array() {
  local items
  items=\$(head -n "\$1" | paste -sd, -)
  printf '[%s]\n' "\$items"
}
prs() {
  printf '%s\n' '{"files":[{"additions":1,"deletions":0,"path":"src/a.ts"}],"headRefOid":"$HEAD_AWAITING","number":11,"title":"Change a"}' '{"files":[{"additions":2,"deletions":1,"path":"docs/guide.md"},{"additions":1,"deletions":0,"path":"README.md"}],"headRefOid":"$HEAD_PASSED","number":12,"title":"Docs"}'
  if [ "\$kind" = many-prs ]; then
    for n in \$(seq 13 41); do
      printf '{"files":[{"additions":1,"deletions":0,"path":"tests/a.test.ts"}],"headRefOid":"$HEAD_OTHER","number":%s,"title":"More %s"}\n' "\$n" "\$n"
    done
  fi
}
awaiting_runs() {
  if [ "\$kind" = many-prs ]; then
    for n in \$(seq 1 20); do printf '%s\n' '{"conclusion":"success"}'; done
  else
    printf '%s\n' '{"conclusion":"success"}'
  fi
  printf '%s\n' '{"conclusion":"action_required"}'
}
garbled() {
  [ "\$kind" = "gh-\$1-garbled" ] && { echo 'gh stub: this is not JSON'; exit 0; }
  return 0
}
case \$args in
  *' issue view '*)
    garbled issue
    n=\$(arg_after view "\$@")
    case \$n in
      1) [ "\$kind" = gh-issue-fails ] && { echo 'gh stub: issue view failed' >&2; exit 1; }
         printf '%s\n' '{"title":"Collect the docs","body":"Something to collect.\n\nPaths: \`docs/guide.md\`; \`src/b.ts\`\n\nMore prose."}' ;;
      2) printf '%s\n' '{"title":"Unknown paths","body":"No paths yet.\nThe Paths: line is missing on purpose."}' ;;
      *) echo "gh stub: no issue \$n" >&2; exit 1 ;;
    esac
    ;;
  *' pr list '*)
    [ "\$kind" = gh-pr-fails ] && { echo 'gh stub: pr list failed' >&2; exit 1; }
    garbled pr
    [ "\$kind" = large-output ] && { printf '[{"files":[],"headRefOid":"$HEAD_OTHER","number":12,"title":"%s"}]\n' "\$(head -c $LARGE_TITLE_BYTES /dev/zero | tr '\\0' x)"; exit 0; }
    prs | json_array "\$(limit_or 30 "\$@")"
    ;;
  *' run list '*)
    [ "\$kind" = gh-run-fails ] && { echo 'gh stub: run list failed' >&2; exit 1; }
    garbled run
    sha=\$(arg_after --commit "\$@")
    case \$sha in
      $HEAD_AWAITING) awaiting_runs | json_array "\$(limit_or 20 "\$@")" ;;
      $HEAD_PASSED) printf '%s\n' '[{"conclusion":"success"}]' ;;
      *) printf '%s\n' '[]' ;;
    esac
    ;;
  *) echo "gh stub: unexpected call: gh \$*" >&2; exit 2 ;;
esac
EOF
  chmod +x "$W/bin/gh"
}

write_queue() {
  local W=$1 kind=$2 repo=$1/repo owner_merges wt_key=worktree extra_key='' b_id='"id": "b",' status task_271='"id": "271", "issue": 1' task_280='"id": "280", "issue": 2'
  owner_merges="\"ownerMerges\": \"$W/handoff/owner-merges.md\","
  status="\"$W/handoff/status.md\""
  case $kind in
    unknown-task-field) wt_key=wroktree ;;
    missing-top-field) owner_merges='' ;;
    unknown-top-field) extra_key='"reviewers": [],' ;;
    missing-task-field) b_id='' ;;
    git-fails) repo=$W/not-a-repo && mkdir -p "$repo" ;;
    repo-missing) repo=$W/no-such-repo ;;
    task-brief-and-issue) task_271="$task_271, \"brief\": \"$W/handoff/brief-b.md\"" ;;
    task-worktree-on-issue) task_280="$task_280, \"worktree\": \"$W/wt-280\"" ;;
    task-wrong-type) task_271='"id": "271", "issue": "1"' ;;
    top-wrong-type) status=7 ;;
  esac
  cat >"$W/queue.json" <<EOF
{ "repo": "$repo", "status": $status, $owner_merges $extra_key
  "tasks": [ { "id": "a", "brief": "$W/handoff/brief-a.md", "$wt_key": "$W/wt-a" }, { $task_271 }, { $b_id
  "brief": "$W/handoff/brief-b.md" }, { $task_280 } ] }
EOF
  if [ "$kind" = relative-paths ]; then
    sed -e "s|\"$W/repo\"|\"repo\"|" -e "s|\"$W/handoff/|\"handoff/|g" "$W/queue.json" >"$W/.world/queue.json"
    mv "$W/.world/queue.json" "$W/queue.json"
  fi
}

write_fs_spy() {
  cat >"$1/.world/fs-spy.mjs" <<'EOF'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const log = process.env.FS_SPY_LOG
const scope = process.env.FS_SPY_SCOPE
function record(op, from, to) {
  if (!log || !scope)
    return
  if (![from, to].some(p => typeof p === 'string' && p.startsWith(scope)))
    return
  fs.appendFileSync(log, `${JSON.stringify({ op, from, to: to ?? null })}\n`)
}
function wrap(target, name, op) {
  const original = target[name]
  if (typeof original !== 'function')
    return
  target[name] = function (...args) {
    record(op, String(args[0]), typeof args[1] === 'string' ? args[1] : undefined)
    return original.apply(this, args)
  }
}
for (const [name, op] of [['mkdtempSync', 'mkdtemp'], ['mkdtemp', 'mkdtemp'], ['renameSync', 'rename'], ['rename', 'rename'], ['cpSync', 'cp'], ['cp', 'cp']])
  wrap(fs, name, op)
for (const [name, op] of [['mkdtemp', 'mkdtemp'], ['rename', 'rename'], ['cp', 'cp']])
  wrap(fs.promises, name, op)
syncBuiltinESMExports()
EOF
}

write_out_appears() {
  cat >"$1/.world/out-appears.mjs" <<EOF
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const out = '$1/snapshot'
function appear(to) {
  if (typeof to !== 'string' || path.resolve(to) !== out)
    return
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'raced.txt'), 'appeared during the run\\n')
}
function wrap(target, name) {
  const original = target[name]
  target[name] = function (...args) {
    appear(args[1])
    return original.apply(this, args)
  }
}
wrap(fs, 'renameSync')
wrap(fs, 'rename')
wrap(fs.promises, 'rename')
syncBuiltinESMExports()
EOF
}

write_empty_out_appears() {
  cat >"$1/.world/empty-out-appears.mjs" <<EOF
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const out = '$1/snapshot'
const original = fs.mkdtempSync
fs.mkdtempSync = function (...args) {
  const created = original.apply(this, args)
  if (path.dirname(path.resolve(String(args[0]))) === path.dirname(out))
    fs.mkdirSync(out)
  return created
}
syncBuiltinESMExports()
EOF
}

write_expected() {
  local W=$1 E=$1/expected
  mkdir -p "$E/tasks"
  { printf 'Worktree: %s\n\n' "$W/wt-a"; sed -n '/^\/implement /,$p' "$W/handoff/brief-a.md"; } >"$E/tasks/01-a.brief.md"
  printf '# Collect the docs\n\nPaths: `docs/guide.md`; `src/b.ts`\n' >"$E/tasks/02-271.issue.md"
  cp "$W/handoff/brief-b.md" "$E/tasks/03-b.brief.md"
  printf '# Unknown paths\n' >"$E/tasks/04-280.issue.md"
  printf '%s\n' README.md "$NON_ASCII_PATH" docs/guide.md src/a.ts src/b.ts tests/a.test.ts >"$E/files.txt"
  cat >"$E/open-prs.json" <<'EOF'
[
  {
    "number": 11,
    "title": "Change a",
    "runsAwaitingApproval": true,
    "files": [
      "src/a.ts"
    ]
  },
  {
    "number": 12,
    "title": "Docs",
    "runsAwaitingApproval": false,
    "files": [
      "docs/guide.md",
      "README.md"
    ]
  }
]
EOF
  cp "$W/handoff/status.md" "$E/status.md"
  cp "$W/handoff/owner-merges.md" "$E/owner-merges.md"
}

new_world() {
  local kind=$1 W
  case " $KINDS " in *" $kind "*) ;; *) echo "world.sh new: unknown kind '$kind' (one of: $KINDS)" >&2; exit 2 ;; esac
  W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/collect-world.XXXXXX")" && pwd -P)
  mkdir -p "$W/.world"
  write_repo "$W"
  write_handoff "$W"
  write_gh "$W" "$kind"
  write_queue "$W" "$kind"
  write_fs_spy "$W"
  write_out_appears "$W"
  write_empty_out_appears "$W"
  write_expected "$W"
  if [ "$kind" = occupied-out ]; then
    mkdir -p "$W/snapshot"
    echo 'left from an earlier run' >"$W/snapshot/keep.txt"
    cp -R "$W/snapshot" "$W/.world/snapshot-before"
  fi
  echo "$kind" >"$W/.world/kind"
  (cd "$W" && ls -A) >"$W/.world/entries-before"
  echo "$W"
}

tree_listing() {
  (cd "$1" && find . -type f | LC_ALL=C sort)
}

check_snapshot() {
  local W=$1 f
  [ -d "$W/snapshot" ] || fail "no $W/snapshot"
  [ "$(tree_listing "$W/snapshot")" = "$(tree_listing "$W/expected")" ] || fail "the files differ: expected '$(tree_listing "$W/expected" | tr '\n' ' ')', got '$(tree_listing "$W/snapshot" | tr '\n' ' ')'"
  for f in $(tree_listing "$W/expected"); do
    cmp -s "$W/expected/$f" "$W/snapshot/$f" || fail "$f differs from the expected snapshot: $(diff "$W/expected/$f" "$W/snapshot/$f" | head -n 20)"
  done
}

check_shredded() {
  local W=$1 rows
  [ -f "$W/shred.json" ] || fail "no $W/shred.json"
  rows=$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(!Array.isArray(j.rows))process.exit(3);console.log(j.rows.map(r=>r.task).join(" "))' "$W/shred.json") || fail "shred.json does not parse or has no rows array"
  [ "$rows" = "$QUEUED_ROWS" ] || fail "rows are '$rows', not '$QUEUED_ROWS'"
}

check_refused() {
  local W=$1 kind entries call key appeared=collect.out
  [ -f "$W/collect.out" ] || fail "no $W/collect.out"
  kind=$(cat "$W/.world/kind")
  case $kind in
    occupied-out)
      grep -qF -- "$W/snapshot" "$W/collect.out" || grep -qi 'exist' "$W/collect.out" || fail "collect.out names neither $W/snapshot nor that it exists"
      diff -r "$W/.world/snapshot-before" "$W/snapshot" >/dev/null 2>&1 || fail "$W/snapshot changed"
      ;;
    gh-pr-fails | gh-issue-fails | gh-run-fails | gh-pr-garbled | gh-issue-garbled | gh-run-garbled)
      case $kind in
        gh-pr-*) call='gh pr list' ;;
        gh-issue-*) call='gh issue view' ;;
        *) call='gh run list' ;;
      esac
      grep -qF "$call" "$W/collect.out" || fail "collect.out does not name the call '$call'"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    unknown-task-field | unknown-top-field)
      key=reviewers
      [ "$kind" = unknown-top-field ] || key=wroktree
      grep -qF "$key" "$W/collect.out" || fail "collect.out does not name the unknown field '$key'"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    missing-top-field)
      grep -qF 'ownerMerges' "$W/collect.out" || fail "collect.out does not name the missing field 'ownerMerges'"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    missing-task-field)
      grep -qw 'id' "$W/collect.out" || fail "collect.out does not name the missing task field 'id'"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    repo-missing)
      grep -qF 'ls-files' "$W/collect.out" && grep -qF 'ENOENT' "$W/collect.out" || fail "collect.out does not name the call 'git … ls-files' and its error ENOENT"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    git-fails)
      grep -qF 'git' "$W/collect.out" && grep -qF 'ls-files' "$W/collect.out" || fail "collect.out does not name the call 'git … ls-files'"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    task-brief-and-issue | task-worktree-on-issue | task-wrong-type | top-wrong-type)
      case $kind in
        task-brief-and-issue) key='brief issue' ;;
        task-worktree-on-issue) key=worktree ;;
        task-wrong-type) key=issue ;;
        *) key=status ;;
      esac
      for k in $key; do
        grep -qw -- "$k" "$W/collect.out" || fail "collect.out does not name the key '$k'"
      done
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    out-appears)
      grep -qi 'rename' "$W/collect.out" || fail "collect.out does not name the failing rename"
      [ "$(cd "$W/snapshot" 2>/dev/null && ls -A)" = raced.txt ] || fail "the directory that appeared at $W/snapshot during the run was changed: '$(ls -A "$W/snapshot" 2>/dev/null | tr '\n' ' ')'"
      appeared=snapshot
      ;;
    empty-out-appears)
      grep -qF -- "$W/snapshot" "$W/collect.out" || fail "collect.out does not name $W/snapshot"
      [ -d "$W/snapshot" ] && [ -z "$(ls -A "$W/snapshot")" ] || fail "the empty directory that appeared at $W/snapshot during the run was replaced: '$(ls -A "$W/snapshot" 2>/dev/null | tr '\n' ' ')'"
      appeared=snapshot
      ;;
    *) fail "check-refused does not apply to a '$kind' world" ;;
  esac
  entries=$(cd "$W" && ls -A | grep -vx -e collect.out -e shred.json -e "$appeared" || true)
  [ "$entries" = "$(cat "$W/.world/entries-before")" ] || fail "entries next to the snapshot changed: before '$(tr '\n' ' ' <"$W/.world/entries-before")', now '$(echo "$entries" | tr '\n' ' ')'"
}

check_rename() {
  local W=$1
  [ -f "$W/.world/fs-spy.log" ] || fail "no $W/.world/fs-spy.log: run the collector with NODE_OPTIONS=--import $W/.world/fs-spy.mjs, FS_SPY_LOG and FS_SPY_SCOPE"
  node - "$W" <<'EOF' || fail "$(cat "$W/.world/rename-failure")"
const fs = require('node:fs')
const path = require('node:path')
const W = process.argv[2]
const out = path.join(W, 'snapshot')
const failWith = (m) => { fs.writeFileSync(`${W}/.world/rename-failure`, m); process.exit(1) }
const ops = fs.readFileSync(`${W}/.world/fs-spy.log`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const temps = ops.filter(o => o.op === 'mkdtemp' && path.dirname(o.from) === W)
if (temps.length !== 1) failWith(`${temps.length} temporary directories created next to ${out}, not 1: ${JSON.stringify(ops)}`)
const renames = ops.filter(o => o.op === 'rename' && o.to === out)
if (renames.length !== 1 || !renames[0].from.startsWith(temps[0].from)) failWith(`${out} was not produced by one rename of the temporary directory ${temps[0].from}*: ${JSON.stringify(ops)}`)
const copies = ops.filter(o => o.op === 'cp')
if (copies.length > 0) failWith(`a directory copy ran: ${JSON.stringify(copies)}`)
EOF
}

check_bytes() {
  local W=$1 f
  for f in status.md owner-merges.md; do
    [ -f "$W/snapshot/$f" ] || fail "no $W/snapshot/$f"
    node -e 'const fs=require("node:fs");const raw=Buffer.from([0xff,0xfe]);const replacement=Buffer.from([0xef,0xbf,0xbd]);const given=fs.readFileSync(process.argv[1]);const got=fs.readFileSync(process.argv[2]);if(!given.includes(raw))process.exit(3);if(got.includes(replacement))process.exit(4);if(!got.includes(raw))process.exit(5)' "$W/handoff/$f" "$W/snapshot/$f" || case $? in
      3) fail "the world's $f carries no invalid UTF-8 bytes 0xff 0xfe" ;;
      4) fail "$f in the snapshot carries U+FFFD: its invalid UTF-8 bytes were replaced" ;;
      *) fail "$f in the snapshot lost the invalid UTF-8 bytes 0xff 0xfe" ;;
    esac
    cmp -s "$W/handoff/$f" "$W/snapshot/$f" || fail "$f in the snapshot is not byte for byte the queue's $f"
  done
}

new_decoy() {
  local name=$1 real D
  case " $DECOYS " in *" $name "*) ;; *) echo "world.sh decoy: unknown decoy '$name' (one of: $DECOYS)" >&2; exit 2 ;; esac
  real="$(pwd -P)/scripts/shredder/collect.ts"
  D=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/collect-decoy.XXXXXX")" && pwd -P)
  printf 'const DECOY = %s\nconst REAL = %s\n' "'$name'" "'$real'" >"$D/$name.mjs"
  cat >>"$D/$name.mjs" <<'EOF'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const out = args[args.indexOf('--out') + 1]
const queueAt = args.indexOf('--queue') + 1
const TASK_KEYS = ['id', 'brief', 'worktree', 'issue']
const TOP_KEYS = ['repo', 'status', 'ownerMerges', 'tasks']

function lenientQueue(queue) {
  if (DECOY === 'lenient-missing-top' && !('ownerMerges' in queue))
    queue.ownerMerges = queue.status
  if (DECOY === 'lenient-missing-task')
    queue.tasks.forEach((task, index) => { task.id ??= `task-${index}` })
  if (DECOY === 'lenient-unknown-task')
    queue.tasks.forEach(task => Object.keys(task).filter(key => !TASK_KEYS.includes(key)).forEach(key => delete task[key]))
  if (DECOY === 'lenient-unknown-top')
    Object.keys(queue).filter(key => !TOP_KEYS.includes(key)).forEach(key => delete queue[key])
  return queue
}

if (DECOY.startsWith('lenient-')) {
  const queue = lenientQueue(JSON.parse(fs.readFileSync(args[queueAt], 'utf8')))
  args[queueAt] = path.join(fs.mkdtempSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'queue-')), 'queue.json')
  fs.writeFileSync(args[queueAt], JSON.stringify(queue))
}
const run = spawnSync(process.execPath, [...process.execArgv, REAL, ...args], { encoding: 'utf8' })
let output = [run.stdout, run.stderr]
if (DECOY === 'unnamed-gh-issue')
  output = output.map(text => text.replace(/(gh )?issue view/g, 'a call'))
if (DECOY === 'unnamed-gh-run')
  output = output.map(text => text.replace(/(gh )?run list/g, 'a call'))
if (DECOY === 'leftover-on-failure' && run.status !== 0)
  fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), '.leftover-'))
for (const [decoy, file] of [['status-as-text', 'status.md'], ['owner-merges-as-text', 'owner-merges.md']]) {
  if (DECOY === decoy && run.status === 0)
    fs.writeFileSync(path.join(out, file), fs.readFileSync(path.join(out, file), 'utf8'))
}
process.stdout.write(output[0])
process.stderr.write(output[1])
process.exit(run.status ?? 1)
EOF
  echo "$D/$name.mjs"
}

CHECK=${1:-}
case $CHECK in
  new) new_world "${2:?usage: world.sh new <$KINDS>}" ;;
  decoy) new_decoy "${2:?usage: world.sh decoy <$DECOYS>}" ;;
  check-snapshot | check-shredded | check-refused | check-rename | check-bytes)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    fn=${CHECK#check-}
    "check_$fn" "$W"
    ;;
  *) echo "usage: world.sh new <${KINDS// /|}> | world.sh decoy <${DECOYS// /|}> | world.sh check-<snapshot|shredded|refused|rename|bytes> <world>" >&2; exit 2 ;;
esac
