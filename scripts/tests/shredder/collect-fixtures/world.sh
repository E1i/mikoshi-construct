#!/usr/bin/env bash
set -euo pipefail

KINDS='ok occupied-out gh-fails'
HEAD_AWAITING=1111111111111111111111111111111111111111
HEAD_PASSED=2222222222222222222222222222222222222222
QUEUED_ROWS='a #271 b #280'

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
  echo 'test' >"$W/repo/tests/a.test.ts"
  git_quiet -C "$W/repo" init
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
  cat >"$W/handoff/brief-a.md" <<'EOF'
# Brief a (world fixture)

This header is not part of the approved text and is never copied into a snapshot.
Design: a label in the header is not the brief's.

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
arg_after() {
  local want=\$1 prev=
  shift
  for a in "\$@"; do
    [ "\$prev" = "\$want" ] && { echo "\$a"; return; }
    prev=\$a
  done
}
case \$args in
  *' issue view '*)
    n=\$(arg_after view "\$@")
    case \$n in
      1) printf '%s\n' '{"title":"Collect the docs","body":"Something to collect.\n\nPaths: \`docs/guide.md\`; \`src/b.ts\`\n\nMore prose."}' ;;
      2) printf '%s\n' '{"title":"Unknown paths","body":"No paths yet.\nThe Paths: line is missing on purpose."}' ;;
      *) echo "gh stub: no issue \$n" >&2; exit 1 ;;
    esac
    ;;
  *' pr list '*)
    [ "\$kind" = gh-fails ] && { echo 'gh stub: pr list failed' >&2; exit 1; }
    printf '%s\n' '[{"files":[{"additions":1,"deletions":0,"path":"src/a.ts"}],"headRefOid":"$HEAD_AWAITING","number":11,"title":"Change a"},{"files":[{"additions":2,"deletions":1,"path":"docs/guide.md"},{"additions":1,"deletions":0,"path":"README.md"}],"headRefOid":"$HEAD_PASSED","number":12,"title":"Docs"}]'
    ;;
  *' run list '*)
    sha=\$(arg_after --commit "\$@")
    case \$sha in
      $HEAD_AWAITING) printf '%s\n' '[{"conclusion":"success"},{"conclusion":"action_required"}]' ;;
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
  local W=$1
  cat >"$W/queue.json" <<EOF
{ "repo": "$W/repo", "status": "$W/handoff/status.md", "ownerMerges": "$W/handoff/owner-merges.md",
  "tasks": [ { "id": "a", "brief": "$W/handoff/brief-a.md", "worktree": "$W/wt-a" }, { "id": "271", "issue": 1 }, { "id": "b",
  "brief": "$W/handoff/brief-b.md" }, { "id": "280", "issue": 2 } ] }
EOF
}

write_expected() {
  local W=$1 E=$1/expected
  mkdir -p "$E/tasks"
  { printf 'Worktree: %s\n\n' "$W/wt-a"; sed -n '/^\/implement /,$p' "$W/handoff/brief-a.md"; } >"$E/tasks/01-a.brief.md"
  printf '# Collect the docs\n\nPaths: `docs/guide.md`; `src/b.ts`\n' >"$E/tasks/02-271.issue.md"
  cp "$W/handoff/brief-b.md" "$E/tasks/03-b.brief.md"
  printf '# Unknown paths\n' >"$E/tasks/04-280.issue.md"
  printf '%s\n' README.md docs/guide.md src/a.ts src/b.ts tests/a.test.ts >"$E/files.txt"
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
  write_queue "$W"
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
  local W=$1 kind entries
  [ -f "$W/collect.out" ] || fail "no $W/collect.out"
  kind=$(cat "$W/.world/kind")
  case $kind in
    occupied-out)
      grep -qF -- "$W/snapshot" "$W/collect.out" || grep -qi 'exist' "$W/collect.out" || fail "collect.out names neither $W/snapshot nor that it exists"
      diff -r "$W/.world/snapshot-before" "$W/snapshot" >/dev/null 2>&1 || fail "$W/snapshot changed"
      ;;
    gh-fails)
      grep -qF 'gh pr list' "$W/collect.out" || fail "collect.out does not name the call 'gh pr list'"
      [ ! -e "$W/snapshot" ] || fail "$W/snapshot exists"
      ;;
    *) fail "check-refused does not apply to a '$kind' world" ;;
  esac
  entries=$(cd "$W" && ls -A | grep -vx -e collect.out -e shred.json || true)
  [ "$entries" = "$(cat "$W/.world/entries-before")" ] || fail "entries next to the snapshot changed: before '$(tr '\n' ' ' <"$W/.world/entries-before")', now '$(echo "$entries" | tr '\n' ' ')'"
}

CHECK=${1:-}
case $CHECK in
  new) new_world "${2:?usage: world.sh new <$KINDS>}" ;;
  check-snapshot | check-shredded | check-refused)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    fn=${CHECK#check-}
    "check_$fn" "$W"
    ;;
  *) echo "usage: world.sh new <${KINDS// /|}> | world.sh check-<snapshot|shredded|refused> <world>" >&2; exit 2 ;;
esac
