import { describe, expect, it } from 'vitest'
import { namedPaths } from '../src/commands/test-runner.js'

const FILE = 'scripts/tests/core/owner-commands-pending.json'

const READINGS = [
  { name: 'a grep -E alternation is not a named path', command: `! grep -qE '"scripts/(core|intake)/' ${FILE}`, named: [FILE] },
  { name: 'a grep -F pattern after -e with an escaped quote is not a named path', command: `! grep -qF -e "\\"scripts/core/" ${FILE}`, named: [FILE] },
  { name: 'a quote-led pattern with no metacharacter is not a named path', command: `grep -q '"scripts/core/' ${FILE}`, named: [FILE] },
  { name: 'a pattern after -E is not a named path even without a metacharacter', command: `grep -E scripts/core/x ${FILE}`, named: [FILE] },
  { name: 'a token with a regex metacharacter is never a plain path', command: `grep -q scripts/[ab]/x scripts/c+/y scripts/^d ${FILE}`, named: [FILE] },
  { name: 'a quoted vitest path stays a named path', command: `pnpm exec vitest run 'tests/test-runner.test.ts'`, named: ['tests/test-runner.test.ts'] },
]

describe('namedPaths reads a grep pattern as no path and its file operand as one', () => {
  it.each(READINGS)('$name', ({ command, named }) => {
    expect(namedPaths(command)).toEqual(named)
  })
})
