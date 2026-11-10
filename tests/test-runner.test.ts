import { describe, expect, it } from 'vitest'
import { namedPaths } from '../src/commands/test-runner.js'

const FILE = 'scripts/tests/core/owner-commands-pending.json'
const ABSENT = 'scripts/absent/file.ts'

const READINGS = [
  { name: 'a grep -E alternation is not a named path', command: `! grep -qE '"scripts/(core|intake)/' ${FILE}`, named: [FILE] },
  { name: 'a grep -F pattern after -e with an escaped quote is not a named path', command: `! grep -qF -e "\\"scripts/core/" ${FILE}`, named: [FILE] },
  { name: 'an unquoted alternation with no pattern flag is not a named path', command: `grep -q scripts/(core|intake)/x scripts/(a/x scripts/a)/x scripts/a|b/x ${FILE}`, named: [FILE] },
  { name: 'a token with a bracket, a plus or a caret is never a plain path', command: `grep -q scripts/[a/x scripts/a]/x scripts/c+/y scripts/^d ${FILE}`, named: [FILE] },
  { name: 'a token with a backslash or a quote inside it is never a plain path', command: `grep -q \\"scripts/core/ scripts/a\\b/x scripts/it's/x scripts/say"hi/x ${FILE}`, named: [FILE] },
  { name: 'a quote-led pattern with no metacharacter is not a named path', command: `grep -q '"scripts/core/' --regexp='"scripts/intake/' ${FILE}`, named: [FILE] },
  { name: 'a grep pattern after -e is not a named path', command: `grep -e scripts/core/x ${FILE}`, named: [FILE] },
  { name: 'a grep pattern after -E is not a named path', command: `grep -E scripts/core/x ${FILE}`, named: [FILE] },
  { name: 'a grep pattern after -F is not a named path', command: `grep -F scripts/core/x ${FILE}`, named: [FILE] },
  { name: 'a grep pattern after a bundled -qF is not a named path', command: `grep -qF scripts/core/x ${FILE}`, named: [FILE] },
  { name: 'a test -e operand stays a named path', command: `! test -e ${ABSENT}`, named: [ABSENT] },
  { name: 'a [ -e ] operand stays a named path', command: `[ -e ${ABSENT} ]`, named: [ABSENT] },
  { name: 'a path after a grep and a separator stays a named path', command: `grep -E x ${FILE} && test -e ${ABSENT}`, named: [FILE, ABSENT] },
  { name: 'a quoted vitest path stays a named path', command: `pnpm exec vitest run 'tests/test-runner.test.ts'`, named: ['tests/test-runner.test.ts'] },
]

describe('namedPaths reads a grep pattern as no path and its file operand as one', () => {
  for (const { name, command, named } of READINGS) {
    it(name, () => {
      expect(namedPaths(command)).toEqual(named)
    })
  }
})
