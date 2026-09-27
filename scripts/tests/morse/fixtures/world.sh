#!/usr/bin/env bash
set -euo pipefail

HEADS='docs src shrunk skill other'
FIXTURES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "$FIXTURES/../../../.." && pwd -P)
CLI="$REPO_ROOT/scripts/morse/cli.ts"

fail() {
  echo "world.sh $CHECK: $*" >&2
  exit 1
}

git_quiet() {
  git -c user.name=world -c user.email=world@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main "$@" >/dev/null 2>&1
}

commit_head() {
  local W=$1 name=$2
  git_quiet -C "$W/repo" add -A
  git_quiet -C "$W/repo" commit -m "$name"
  git -C "$W/repo" rev-parse HEAD >"$W/sha/$name"
  git_quiet -C "$W/repo" checkout --detach "$(cat "$W/sha/base")"
}

new_world() {
  local W
  W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/morse-world.XXXXXX")" && pwd -P)
  mkdir -p "$W/.world" "$W/sha" "$W/repo/docs" "$W/repo/src" "$W/repo/tests" "$W/repo/scripts" "$W/repo/.claude/skills/s" "$W/repo/.changeset"
  echo '# world' >"$W/repo/README.md"
  printf 'one\ntwo\n' >"$W/repo/docs/guide.md"
  echo 'export const a = 1' >"$W/repo/src/a.ts"
  printf 'first\nsecond\nthird\n' >"$W/repo/tests/a.test.ts"
  echo 'export const x = 1' >"$W/repo/scripts/x.ts"
  echo '# skill' >"$W/repo/.claude/skills/s/SKILL.md"
  git_quiet -C "$W/repo" init
  git_quiet -C "$W/repo" add -A
  git_quiet -C "$W/repo" commit -m base
  git -C "$W/repo" rev-parse HEAD >"$W/sha/base"
  git_quiet -C "$W/repo" checkout --detach

  echo three >>"$W/repo/docs/guide.md"
  echo 'a changeset' >"$W/repo/.changeset/one.md"
  commit_head "$W" docs

  echo 'export const a = 2' >"$W/repo/src/a.ts"
  commit_head "$W" src

  printf 'first\nthird\n' >"$W/repo/tests/a.test.ts"
  commit_head "$W" shrunk

  echo 'more' >>"$W/repo/.claude/skills/s/SKILL.md"
  commit_head "$W" skill

  echo 'export const x = 2' >"$W/repo/scripts/x.ts"
  commit_head "$W" other

  cat >"$W/.world/expected.jsonl" <<EOF
{"task":"t-docs","base":"$(cat "$W/sha/base")","head":"$(cat "$W/sha/docs")","verdict":"cheap","rule":"docs-only","why":[".changeset/one.md","docs/guide.md"]}
{"task":"t-src","base":"$(cat "$W/sha/base")","head":"$(cat "$W/sha/src")","verdict":"ladder","rule":"src","why":["src/a.ts"]}
{"task":"t-shrunk","base":"$(cat "$W/sha/base")","head":"$(cat "$W/sha/shrunk")","verdict":"ladder","rule":"tests-shrunk","why":["tests/a.test.ts"]}
{"task":"t-skill","base":"$(cat "$W/sha/base")","head":"$(cat "$W/sha/skill")","verdict":"ladder","rule":"instructions","why":[".claude/skills/s/SKILL.md"]}
{"task":"t-other","base":"$(cat "$W/sha/base")","head":"$(cat "$W/sha/other")","verdict":"ladder","rule":"doubt","why":["scripts/x.ts"]}
EOF
  echo world >"$W/.world/kind"
  echo "$W"
}

same_json() {
  node -e 'const u=require("node:util");const fs=require("node:fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));process.exit(u.isDeepStrictEqual(a,b)?0:1)' "$1" "$2"
}

check_predicted() {
  local W=$1 journal n i
  journal="$W/repo/.construct/morse.jsonl"
  [ -f "$journal" ] || fail "no $journal"
  n=$(wc -l <"$journal" | tr -d ' ')
  [ "$n" = 5 ] || fail "$n lines in $journal, not 5"
  for i in 1 2 3 4 5; do
    sed -n "${i}p" "$journal" >"$W/.world/got"
    sed -n "${i}p" "$W/.world/expected.jsonl" >"$W/.world/want"
    same_json "$W/.world/got" "$W/.world/want" || fail "line $i is $(cat "$W/.world/got"), not $(cat "$W/.world/want")"
  done
  for i in 1 2 3 4 5; do
    sed -n "${i}p" "$W/predict.stdout" >"$W/.world/got"
    sed -n "${i}p" "$W/.world/expected.jsonl" >"$W/.world/want"
    same_json "$W/.world/got" "$W/.world/want" || fail "stdout line $i is $(cat "$W/.world/got"), not $(cat "$W/.world/want")"
  done
}

check_empty() {
  local W=$1
  [ -f "$W/predict.out" ] || fail "no $W/predict.out"
  grep -qi 'empty' "$W/predict.out" || fail "predict.out does not say the diff is empty"
  [ ! -e "$W/repo/.construct/morse.jsonl" ] || fail "a line was appended for an empty diff"
}

check_rules() {
  local d name out
  for d in "$FIXTURES"/rules/*/; do
    name=$(basename "$d")
    out=$(cd "$REPO_ROOT" && pnpm exec tsx "$CLI" classify --files "$d/files.json" 2>&1) || fail "$name: classify exited non-zero: $out"
    printf '%s\n' "$out" >"${TMPDIR:-/tmp}/morse-rule-got.json"
    same_json "${TMPDIR:-/tmp}/morse-rule-got.json" "$d/expected.json" || fail "$name: got $out, expected $(tr -d '\n ' <"$d/expected.json")"
  done
}

check_backtest() {
  local dir first second
  dir=$(mktemp -d "${TMPDIR:-/tmp}/morse-backtest.XXXXXX")
  first=$(cd "$REPO_ROOT" && pnpm exec tsx "$CLI" backtest --prs "$FIXTURES/backtest/synthetic.jsonl" 2>/dev/null) || fail "backtest exited non-zero"
  second=$(cd "$REPO_ROOT" && pnpm exec tsx "$CLI" backtest --prs "$FIXTURES/backtest/synthetic.jsonl" 2>/dev/null) || fail "backtest exited non-zero on the second run"
  [ "$first" = "$second" ] || fail "two runs over the same input differ"
  printf '%s\n' "$first" >"$dir/got.json"
  same_json "$dir/got.json" "$FIXTURES/backtest/synthetic.expected.json" || fail "backtest printed $(tr -d '\n ' <"$dir/got.json"), expected $(tr -d '\n ' <"$FIXTURES/backtest/synthetic.expected.json")"
}

CHECK=${1:-}
case $CHECK in
  new) new_world ;;
  heads) echo "$HEADS" ;;
  check-predicted | check-empty)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    fn=${CHECK#check-}
    "check_$fn" "$W"
    ;;
  check-rules) check_rules ;;
  check-backtest) check_backtest ;;
  *) echo "usage: world.sh new | world.sh heads | world.sh check-<predicted|empty> <world> | world.sh check-<rules|backtest>" >&2; exit 2 ;;
esac
