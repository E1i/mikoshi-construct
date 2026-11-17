import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { hookAnswer, MAX_TEST_DIRECTORIES, vitestVerdict, WIDE_VITEST_HOOKS, WIDE_VITEST_RULE } from '../../ports/wide-vitest-guard.js'

const VERDICTS: Record<string, 'allow' | 'refuse'> = {
  'pnpm exec vitest run scripts/tests/shift/prompt.test.ts': 'allow',
  'pnpm --dir /tmp/tree exec vitest run scripts/tests/bus/answerer.test.ts scripts/tests/shift/prompt.test.ts': 'allow',
  'pnpm exec vitest run scripts/tests/a/x.test.ts scripts/tests/b scripts/tests/c scripts/tests/d': 'allow',
  'pnpm exec vitest run -t "the guard" --reporter dot scripts/tests/ports/wide-vitest-guard.test.ts': 'allow',
  'node_modules/.bin/vitest run tests/card/closed.test.ts:12': 'allow',
  'pnpm exec vitest run scripts/tests/bus scripts/tests/contract scripts/tests/core scripts/tests/supervisor scripts/tests/policy scripts/tests/nodes': 'refuse',
  'pnpm exec vitest run scripts/tests/a/x.test.ts scripts/tests/b scripts/tests/c scripts/tests/d scripts/tests/e': 'refuse',
  'pnpm exec vitest run scripts/tests/bus': 'refuse',
  'pnpm exec vitest run': 'refuse',
  'npx vitest': 'refuse',
  'pnpm typecheck && pnpm exec vitest run scripts/tests/core': 'refuse',
  'pnpm exec vitest --version': 'allow',
  'pnpm exec node --import tsx scripts/ci/prepush.ts': 'allow',
  'grep -n vitest package.json': 'allow',
  'pnpm lint': 'allow',
}

describe('the wide-vitest guard', () => {
  it.each(Object.entries(VERDICTS))('%s → %s', (command, expected) => {
    expect(vitestVerdict(command).kind).toBe(expected)
  })

  it('the guard refuses a wide vitest command and allows a file-level one', () => {
    const wide = vitestVerdict('pnpm exec vitest run scripts/tests/bus scripts/tests/core scripts/tests/nodes scripts/tests/window scripts/tests/ports')
    const noFile = vitestVerdict('pnpm exec vitest run scripts/tests/bus')
    const fileLevel = vitestVerdict('pnpm exec vitest run scripts/tests/bus/answerer.test.ts scripts/tests/shift/prompt.test.ts')
    expect(wide.kind === 'refuse' && wide.reason).toContain(`more than ${MAX_TEST_DIRECTORIES}`)
    expect(wide.kind === 'refuse' && wide.reason).toContain(WIDE_VITEST_RULE)
    expect(noFile.kind === 'refuse' && noFile.reason).toContain('names no test file')
    expect(noFile.kind === 'refuse' && noFile.reason).toContain(WIDE_VITEST_RULE)
    expect(fileLevel).toEqual({ kind: 'allow' })
  })

  it('answers a refused Bash call with a PreToolUse deny that names the rule, and stays silent otherwise', () => {
    const refused = hookAnswer(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm exec vitest run' } }))
    expect(JSON.parse(refused!)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(WIDE_VITEST_RULE) } })
    expect([
      hookAnswer(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm exec vitest run a.test.ts' } })),
      hookAnswer(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'vitest' } })),
      hookAnswer('not json'),
    ]).toEqual([null, null, null])
  })

  it('the hook command the settings install runs the guard on its stdin', () => {
    const command = WIDE_VITEST_HOOKS.PreToolUse[0].hooks[0].command
    const run = (input: unknown): string => execSync(command, { input: JSON.stringify(input), encoding: 'utf8' })
    const refused = run({ tool_name: 'Bash', tool_input: { command: 'pnpm exec vitest run scripts/tests/bus' } })
    const allowed = run({ tool_name: 'Bash', tool_input: { command: 'pnpm exec vitest run scripts/tests/bus/answerer.test.ts' } })
    expect({ refused: JSON.parse(refused).hookSpecificOutput.permissionDecision, allowed }).toEqual({ refused: 'deny', allowed: '' })
  })
})
