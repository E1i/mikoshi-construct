#!/usr/bin/env bash
set -euo pipefail

HEADS='docs src shrunk skill other rename-test rename-doc binary-test binary-other src-shrunk empty-test-deleted empty-test-added quoted-doc quoted-src'
TAB=$(printf '\t')
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

expect_line() {
  local W=$1 head=$2 verdict=$3 rule=$4 why=$5
  printf '{"task":"t-%s","base":"%s","head":"%s","verdict":"%s","rule":"%s","why":[%s]}\n' \
    "$head" "$(cat "$W/sha/base")" "$(cat "$W/sha/$head")" "$verdict" "$rule" "$why" >"$W/.world/expect/$head"
}

new_world() {
  local W
  W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/morse-world.XXXXXX")" && pwd -P)
  mkdir -p "$W/.world/expect" "$W/sha" "$W/repo/docs" "$W/repo/src" "$W/repo/tests/fixtures" "$W/repo/scripts" "$W/repo/.claude/skills/s" "$W/repo/.changeset" "$W/repo/assets"
  echo '# world' >"$W/repo/README.md"
  printf 'one\ntwo\n' >"$W/repo/docs/guide.md"
  echo 'export const a = 1' >"$W/repo/src/a.ts"
  printf 'first\nsecond\nthird\n' >"$W/repo/tests/a.test.ts"
  : >"$W/repo/tests/empty.test.ts"
  echo 'export const x = 1' >"$W/repo/scripts/x.ts"
  echo '# skill' >"$W/repo/.claude/skills/s/SKILL.md"
  printf 'PNG\000\001\002\003' >"$W/repo/tests/fixtures/logo.bin"
  printf 'PNG\000\004\005\006' >"$W/repo/assets/logo.bin"
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

  git_quiet -C "$W/repo" mv tests/a.test.ts tests/b.test.ts
  commit_head "$W" rename-test

  git_quiet -C "$W/repo" mv docs/guide.md docs/manual.md
  commit_head "$W" rename-doc

  printf 'PNG\000\011\012\013' >"$W/repo/tests/fixtures/logo.bin"
  commit_head "$W" binary-test

  printf 'PNG\000\014\015\016' >"$W/repo/assets/logo.bin"
  commit_head "$W" binary-other

  echo 'export const a = 3' >"$W/repo/src/a.ts"
  printf 'first\nthird\n' >"$W/repo/tests/a.test.ts"
  commit_head "$W" src-shrunk

  git_quiet -C "$W/repo" rm tests/empty.test.ts
  commit_head "$W" empty-test-deleted

  : >"$W/repo/tests/new.test.ts"
  commit_head "$W" empty-test-added

  echo 'a tab in the name' >"$W/repo/docs/tab${TAB}name.md"
  commit_head "$W" quoted-doc

  echo 'export const t = 1' >"$W/repo/src/tab${TAB}name.ts"
  commit_head "$W" quoted-src

  expect_line "$W" docs cheap docs-only '".changeset/one.md","docs/guide.md"'
  expect_line "$W" src ladder src '"src/a.ts"'
  expect_line "$W" shrunk ladder tests-shrunk '"tests/a.test.ts"'
  expect_line "$W" skill ladder instructions '".claude/skills/s/SKILL.md"'
  expect_line "$W" other ladder doubt '"scripts/x.ts"'
  expect_line "$W" rename-test ladder tests-shrunk '"tests/a.test.ts"'
  expect_line "$W" rename-doc cheap docs-only '"docs/guide.md","docs/manual.md"'
  expect_line "$W" binary-test ladder tests-shrunk '"tests/fixtures/logo.bin"'
  expect_line "$W" binary-other ladder doubt '"assets/logo.bin"'
  expect_line "$W" src-shrunk ladder tests-shrunk '"tests/a.test.ts"'
  expect_line "$W" empty-test-deleted ladder tests-shrunk '"tests/empty.test.ts"'
  expect_line "$W" empty-test-added ladder doubt '"tests/new.test.ts"'
  expect_line "$W" quoted-doc cheap docs-only '"docs/tab\tname.md"'
  expect_line "$W" quoted-src ladder src '"src/tab\tname.ts"'
  echo world >"$W/.world/kind"
  echo "$W"
}

same_json() {
  node -e 'const u=require("node:util");const fs=require("node:fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));process.exit(u.isDeepStrictEqual(a,b)?0:1)' "$1" "$2"
}

repo_untouched() {
  local W=$1 dirty
  [ ! -e "$W/repo/.construct/morse.jsonl" ] || fail "a journal was written inside the repository"
  dirty=$(git -C "$W/repo" status --porcelain --untracked-files=all)
  [ -z "$dirty" ] || fail "the repository was written to: $dirty"
}

check_predicted() {
  local W=$1 journal n i head
  shift
  [ $# -gt 0 ] || set -- $HEADS
  journal="$W/morse.jsonl"
  repo_untouched "$W"
  [ -f "$journal" ] || fail "no $journal"
  n=$(wc -l <"$journal" | tr -d ' ')
  [ "$n" = $# ] || fail "$n lines in $journal, not $#"
  [ -f "$W/predict.stdout" ] || fail "no $W/predict.stdout"
  i=0
  for head in "$@"; do
    i=$((i + 1))
    [ -f "$W/.world/expect/$head" ] || fail "no head $head in this world"
    sed -n "${i}p" "$journal" >"$W/.world/got"
    same_json "$W/.world/got" "$W/.world/expect/$head" || fail "line $i is $(cat "$W/.world/got"), not $(cat "$W/.world/expect/$head")"
    sed -n "${i}p" "$W/predict.stdout" >"$W/.world/got"
    same_json "$W/.world/got" "$W/.world/expect/$head" || fail "stdout line $i is $(cat "$W/.world/got"), not $(cat "$W/.world/expect/$head")"
  done
}

no_journal_anywhere() {
  local W=$1 found
  found=$(find "$W" -name 'morse.jsonl' -not -path "$W/.world/*" | head -n 1)
  [ -z "$found" ] || fail "a journal was written: $found"
}

check_refused() {
  local W=$1 needle=${2:-}
  [ -f "$W/predict.out" ] || fail "no $W/predict.out"
  if [ -n "$needle" ]; then
    grep -qiF -- "$needle" "$W/predict.out" || fail "predict.out does not say: $needle"
  fi
  no_journal_anywhere "$W"
  repo_untouched "$W"
}

check_empty() {
  check_refused "$1" 'the diff is empty'
}

check_no_journal() {
  check_refused "$1" '--journal'
}

check_unprinted() {
  local W=$1 left
  [ -f "$W/predict.stdout" ] || fail "no $W/predict.stdout"
  if grep -qF '"task"' "$W/predict.stdout"; then
    fail "the line was printed although it was not appended: $(cat "$W/predict.stdout")"
  fi
  [ -d "$W/jdir" ] || fail "no $W/jdir"
  left=$(find "$W/jdir" -mindepth 1 | head -n 1)
  [ -z "$left" ] || fail "something was written into $W/jdir: $left"
  repo_untouched "$W"
}

check_anchor() {
  local W=$1 head=${2:?usage: world.sh check-anchor <world> <head>} n
  [ -f "$W/anchor.jsonl" ] || fail "no $W/anchor.jsonl: the anchoring run did not append"
  n=$(wc -l <"$W/anchor.jsonl" | tr -d ' ')
  [ "$n" = 1 ] || fail "$n lines in $W/anchor.jsonl, not 1"
  same_json "$W/anchor.jsonl" "$W/.world/expect/$head" || fail "the anchoring line is $(cat "$W/anchor.jsonl"), not $(cat "$W/.world/expect/$head")"
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

check_backtest_refused() {
  local case=$1 input names status out err name
  input="$FIXTURES/backtest/refused/$case.jsonl"
  names="$FIXTURES/backtest/refused/$case.names"
  [ -f "$input" ] && [ -f "$names" ] || fail "no refused case $case"
  out=$(mktemp "${TMPDIR:-/tmp}/morse-refused-out.XXXXXX")
  err=$(mktemp "${TMPDIR:-/tmp}/morse-refused-err.XXXXXX")
  status=0
  (cd "$REPO_ROOT" && pnpm exec tsx "$CLI" backtest --prs "$input" >"$out" 2>"$err") || status=$?
  [ "$status" -ne 0 ] || fail "$case: backtest accepted the file: $(tr -d '\n ' <"$out")"
  if grep -qF '"matrix"' "$out"; then
    fail "$case: backtest printed a result although it refused the file"
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    cat "$out" "$err" | grep -qwF -- "$name" || fail "$case: the refusal does not name $name: $(cat "$err")"
  done <"$names"
}

check_classify_empty() {
  local out err status
  out=$(mktemp "${TMPDIR:-/tmp}/morse-classify-out.XXXXXX")
  err=$(mktemp "${TMPDIR:-/tmp}/morse-classify-err.XXXXXX")
  status=0
  (cd "$REPO_ROOT" && pnpm exec tsx "$CLI" classify --files "$FIXTURES/classify/empty.json" >"$out" 2>"$err") || status=$?
  [ "$status" -ne 0 ] || fail "classify accepted an empty list: $(cat "$out")"
  if grep -qF '"verdict"' "$out"; then
    fail "classify printed a prediction for an empty list"
  fi
  cat "$out" "$err" | grep -qiF 'the diff is empty' || fail "the refusal does not say the diff is empty: $(cat "$err")"
}

check_order() {
  (cd "$REPO_ROOT" && pnpm exec tsx "$FIXTURES/order-probe.mjs") || fail "the rule order is not read from RULES"
}

check_suite() {
  local report=${1:?usage: world.sh check-suite <vitest.json>}
  [ -f "$report" ] || fail "no $report"
  node -e '
const fs = require("node:fs")
const path = require("node:path")
const [report, fixtures, heads, suite] = process.argv.slice(1)
const r = JSON.parse(fs.readFileSync(report, "utf8"))
const passed = new Set(r.testResults.flatMap(f => f.assertionResults).filter(t => t.status === "passed").map(t => t.title))
const required = [
  ...fs.readdirSync(path.join(fixtures, "rules")).sort().map(d => `rule ${d}`),
  "rule order follows RULES",
  "classify refuses an empty list",
  ...heads.split(" ").filter(Boolean).map(h => `predict ${h}`),
  "predict without --repo",
  "predict refuses a missing --journal",
  "predict refuses an empty diff",
  "predict refuses an unknown revision",
  "predict refuses a failing append",
  "backtest synthetic",
  ...fs.readdirSync(path.join(fixtures, "backtest", "refused")).filter(f => f.endsWith(".jsonl")).sort().map(f => `backtest refuses ${f.slice(0, -6)}`),
]
const lacking = required.filter(t => passed.has(t) === false)
const problems = []
if (r.success !== true)
  problems.push("the suite did not pass")
if (lacking.length > 0)
  problems.push(`no passing test titled: ${lacking.join("; ")}`)
const text = fs.existsSync(suite) ? fs.readFileSync(suite, "utf8") : ""
if (text.includes("synthetic.expected.json") === false)
  problems.push(`${suite} does not compare the backtest with synthetic.expected.json`)
if (problems.length > 0) {
  process.stderr.write(`world.sh check-suite: ${problems.join("\n")}\n`)
  process.exit(1)
}
' "$report" "$FIXTURES" "$HEADS" "$REPO_ROOT/scripts/tests/morse/cli.test.ts"
}

CHECK=${1:-}
case $CHECK in
  new) new_world ;;
  heads) echo "$HEADS" ;;
  check-predicted | check-refused | check-empty | check-no-journal | check-unprinted | check-anchor)
    W=${2:?usage: world.sh $CHECK <world>}
    [ -f "$W/.world/kind" ] || fail "$W is not a world"
    shift 2
    fn=${CHECK#check-}
    "check_${fn//-/_}" "$W" "$@"
    ;;
  check-rules) check_rules ;;
  check-backtest) check_backtest ;;
  check-backtest-refused) check_backtest_refused "${2:?usage: world.sh check-backtest-refused <case>}" ;;
  check-classify-empty) check_classify_empty ;;
  check-order) check_order ;;
  check-suite) check_suite "${2:?usage: world.sh check-suite <vitest.json>}" ;;
  *) echo "usage: world.sh new | world.sh heads | world.sh check-<predicted|refused|empty|no-journal|unprinted|anchor> <world> [...] | world.sh check-<rules|backtest|classify-empty|order> | world.sh check-suite <vitest.json> | world.sh check-backtest-refused <case>" >&2; exit 2 ;;
esac
