import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-acceptance.mjs')

interface CheckAcceptance {
  normalizeItem: (item: string) => string
  agreedItems: (text: string) => string[] | null
  agreedInvariants: (text: string) => string[]
  agreedImmutable: (text: string) => string[]
  argsAcceptance: (json: string) => string[]
  missingItems: (agreed: string[], acceptance: string[]) => string[]
  buildArgs: (text: string) => { acceptance: string[], invariants: string[] }
}

const { agreedImmutable, agreedInvariants, agreedItems, argsAcceptance, buildArgs, missingItems, normalizeItem } = await import(pathToFileURL(SCRIPT).href) as CheckAcceptance

const BRIEF_1037_HEAD = [
  '/implement Gate Ghost, shift and review launches on the runtime isolation level (#1037).',
  'Sketch: none — independent implementation is the witness',
  '',
]

const BRIEF_1037_OLD_FORM = [
  ...BRIEF_1037_HEAD,
  'Acceptance:',
  '- W1, a launch with no runtime isolation is refused and starts no session — witness: `pnpm exec vitest run scripts/tests/bus/launch-node.test.ts -t \'a launch with no runtime isolation is refused and writes no session\'`',
  '- W2, the launch event names the isolation level — witness: `pnpm exec vitest run scripts/tests/bus/launch-node.test.ts -t \'the launch event names the isolation level\'`',
  '- W3, a review with no runtime isolation is refused — witness: `pnpm exec vitest run scripts/tests/bus/review-worker.test.ts -t \'a review with no runtime isolation is refused\'`',
  '- W4, an enabled sandbox that allows unsandboxed commands reads partial — witness: `pnpm exec vitest run scripts/tests/ghosts/isolation.test.ts -t \'an enabled sandbox that allows unsandboxed commands reads partial\'`',
  '- W5, bg starts no shift without runtime isolation — witness: `pnpm exec vitest run scripts/tests/shift/bg.test.ts -t \'bg starts no shift without runtime isolation\'`',
  '',
  'Invariants:',
  '- I1, types and lint hold with the port required everywhere — witness: `pnpm typecheck`; `pnpm exec eslint scripts/ghosts/isolation.ts scripts/bus scripts/shift scripts/tests/ghosts/isolation.test.ts scripts/tests/bus scripts/tests/shift`',
  '- I2, the neighbouring suites stay green — witness: `pnpm exec vitest run scripts/tests/bus scripts/tests/shift scripts/tests/ghosts`',
  '- I3, the file registries agree (isolation.ts has its ghosts row) — witness: `pnpm exec vitest run scripts/tests/shredder`',
  '- I4, the quality gate is green, run as its own command — witness: `pnpm run quality`',
  '- I5, nothing outside the card\'s touches changes — witness: `! git diff HEAD --name-only | grep -vxE \'scripts/shift/(bg|merge)\\.ts|scripts/ghosts/isolation\\.ts\'`',
  '- I6, no comment is added — witness: `! git diff HEAD -U0 -- scripts | grep -E \'^[+]\\s*(//|/[*])\'`',
].join('\n')

const BRIEF_1037_FIXED_FORM = [
  ...BRIEF_1037_HEAD,
  'Acceptance:',
  '- W1, a launch with no runtime isolation is refused and starts no session — witness: `pnpm exec vitest run scripts/tests/bus/launch-node.test.ts -t \'a launch with no runtime isolation is refused and writes no session\'`;',
  '- W2, the launch event names the isolation level — witness: `pnpm exec vitest run scripts/tests/bus/launch-node.test.ts -t \'the launch event names the isolation level\'`;',
  '- W3, a review with no runtime isolation is refused — witness: `pnpm exec vitest run scripts/tests/bus/review-worker.test.ts -t \'a review with no runtime isolation is refused\'`;',
  '- W4, an enabled sandbox that allows unsandboxed commands reads partial — witness: `pnpm exec vitest run scripts/tests/ghosts/isolation.test.ts -t \'an enabled sandbox that allows unsandboxed commands reads partial\'`;',
  '- W5, bg starts no shift without runtime isolation — witness: `pnpm exec vitest run scripts/tests/shift/bg.test.ts -t \'bg starts no shift without runtime isolation\'`.',
  '',
  'Invariants:',
  '- I1a, types hold with the port required everywhere — witness: `pnpm typecheck`;',
  '- I1b, lint holds on the touched code — witness: `pnpm exec eslint scripts/ghosts/isolation.ts scripts/bus scripts/shift scripts/tests/ghosts/isolation.test.ts scripts/tests/bus scripts/tests/shift`;',
  '- I2, the neighbouring suites stay green — witness: `pnpm exec vitest run scripts/tests/bus scripts/tests/shift scripts/tests/ghosts`;',
  '- I3, the file registries agree (isolation.ts has its ghosts row) — witness: `pnpm exec vitest run scripts/tests/shredder`;',
  '- I4, the quality gate is green, run as its own command — witness: `pnpm run quality`;',
  '- I5, nothing outside the card\'s touches changes — witness: `! git diff HEAD --name-only | grep -vxE \'scripts/shift/(bg|merge)\\.ts|scripts/ghosts/isolation\\.ts\'`;',
  '- I6, no comment is added — witness: `! git diff HEAD -U0 -- scripts | grep -E \'^[+]\\s*(//|/[*])\'`',
].join('\n')

const AGREED = [
  '/implement Acceptance echo in the ladder:',
  'the ladder echoes what it received.',
  'Acceptance: a ladder-run test shows `acceptance` equal to the args — witness: `pnpm vitest run tests/ladder-run.test.ts -t echoes`;',
  'the template copy is byte-identical — witness: `cmp a.mjs b.mjs; test $? -eq 0`;',
  '  minor changeset starting `templates:` — witness: `grep -l templates: .changeset/*.md`.',
  'Invariants: pnpm run quality stays green.',
  'Mutations: M1 | the echo only in `done` | red: the failed test',
].join('\n')

const WITNESSES = [
  { criterion: 'a ladder-run test shows `acceptance` equal to the args', command: 'pnpm vitest run tests/ladder-run.test.ts -t echoes' },
  { criterion: 'the template copy is byte-identical', command: 'cmp a.mjs b.mjs; test $? -eq 0' },
  { criterion: 'minor changeset starting `templates:`', command: 'grep -l templates: .changeset/*.md' },
]

const INVARIANTS = ['pnpm run quality stays green']

const ITEMS = [
  'a ladder-run test shows `acceptance` equal to the args',
  'the template copy is byte-identical',
  'minor changeset starting `templates:`',
]

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function runCheck(agreed: string, args: string): { status: number | null, stdout: string, stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-acceptance-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'agreed.txt'), agreed)
  writeFileSync(path.join(dir, 'args.json'), args)
  const child = spawnSync(process.execPath, [SCRIPT, '--agreed', path.join(dir, 'agreed.txt'), '--args', path.join(dir, 'args.json')], { encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

describe('the agreed Acceptance section', () => {
  it('runs from the label to Invariants or Mutations, split on semicolons outside backticks, without the witness', () => {
    expect(agreedItems(AGREED)).toEqual(ITEMS)
  })

  it('reads the Invariants section apart from the acceptance', () => {
    expect(agreedInvariants(AGREED)).toEqual(INVARIANTS)
    expect(agreedInvariants('Acceptance: one')).toEqual([])
  })

  it('runs to the end of the text when no Mutations follow', () => {
    expect(agreedItems('Task. Acceptance: one; two.')).toEqual(['one', 'two'])
  })

  it('ends at a sentence starting Mutations on the same line', () => {
    expect(agreedItems('Acceptance: one; two. Mutations: M1 | x | red')).toEqual(['one', 'two'])
  })

  it('is absent when the label is', () => {
    expect(agreedItems('/implement add a rule')).toBeNull()
  })
})

describe('the build of a brief\'s items', () => {
  it('refuses an item that holds more than one witness marker', () => {
    const glued = [
      ...BRIEF_1037_HEAD,
      'Acceptance:',
      '- W1, one — witness: `true`',
      '- W2, two — witness: `true`',
    ].join('\n')
    expect(() => buildArgs(glued)).toThrow('more than one witness marker in one item; end each item with ;: - W1, one — witness: `true` - W2, two')
  })

  it('refuses the #1037 brief in its old form and builds it with each item ended by a semicolon', () => {
    expect(() => buildArgs(BRIEF_1037_OLD_FORM)).toThrow('more than one witness marker in one item')
    expect(() => buildArgs(BRIEF_1037_OLD_FORM)).toThrow('an item cut off its boundary, it begins with a command that continues the witness before it; give each witness command its own item: `pnpm exec eslint')
    const built = buildArgs(BRIEF_1037_FIXED_FORM)
    expect(built.acceptance).toHaveLength(5)
    expect(built.invariants).toHaveLength(7)
  })
})

describe('the agreed Immutable section', () => {
  const brief = [
    'Acceptance: the rule rejects the case — witness: `pnpm vitest run tests/rule.test.ts`.',
    'Immutable: `tests/rule.test.ts`; templates/.',
    'Invariants: pnpm run quality stays green.',
  ].join('\n')

  it('reads its paths without backticks and ends the acceptance and invariants before it', () => {
    expect(agreedImmutable(brief)).toEqual(['tests/rule.test.ts', 'templates/'])
    expect(agreedItems(brief)).toEqual(['the rule rejects the case'])
    expect(agreedInvariants(brief)).toEqual(['pnpm run quality stays green'])
  })

  it('ends at Mutations whether its explanation follows on the next line or in parentheses before the colon', () => {
    const head = 'Acceptance: the rule rejects the case — witness: `pnpm vitest run tests/rule.test.ts`.\nImmutable: `tests/rule.test.ts`; templates/.\n'
    const nextLine = `${head}Mutations:\n(predicted before the run)\nM1 | drop the check | red: the rule test`
    const parenthesised = `${head}Mutations (predicted before the run): M1 | drop the check | red: the rule test`

    expect(agreedImmutable(nextLine)).toEqual(['tests/rule.test.ts', 'templates/'])
    expect(agreedImmutable(parenthesised)).toEqual(['tests/rule.test.ts', 'templates/'])
    expect(agreedInvariants('Acceptance: x — witness: `true`.\nInvariants: quality stays green.\nMutations (predicted before the run): M1 | y')).toEqual(['quality stays green'])
  })

  it('stops when an immutable path dropped out before the call, and passes once it is carried', () => {
    const args = { acceptance: ['the rule rejects the case'], witnesses: [{ criterion: 'the rule rejects the case', command: 'pnpm vitest run tests/rule.test.ts' }], invariants: ['pnpm run quality stays green'] }
    const dropped = runCheck(brief, JSON.stringify({ ...args, immutable: ['tests/rule.test.ts'] }))
    const carried = runCheck(brief, JSON.stringify({ ...args, immutable: ['tests/rule.test.ts', 'templates/'] }))

    expect(dropped.status).toBe(1)
    expect(dropped.stderr).toContain('immutable path missing from the args: templates/')
    expect(carried.status).toBe(0)
  })
})

describe('matching agreed items against args.acceptance', () => {
  it('normalises both sides the same way', () => {
    expect(normalizeItem('  a   b\n c. ')).toBe('a b c')
    expect(missingItems(['a b c'], ['a  b c.'])).toEqual([])
  })

  it('does not count an item as present when it is only a substring of an element', () => {
    expect(missingItems(['the harness'], ['the harness is green'])).toEqual(['the harness'])
  })

  it('reads a missing args.acceptance as empty and refuses one that is not an array of strings', () => {
    expect(argsAcceptance('{"task":"t"}')).toEqual([])
    expect(() => argsAcceptance('{"acceptance":[1]}')).toThrow('not an array of strings')
  })
})

describe('the check the skill runs before the Workflow call', () => {
  it('stops when an agreed item dropped out before the call', () => {
    const result = runCheck(AGREED, JSON.stringify({ task: 't', acceptance: [ITEMS[0], ITEMS[2]], witnesses: WITNESSES, invariants: INVARIANTS }))

    expect(result.status).toBe(1)
    expect(result.stderr.split('\n').filter(Boolean)).toEqual([ITEMS[1]])
  })

  it('passes when every agreed item is in the args verbatim with the brief\'s witness, and every invariant is carried', () => {
    const result = runCheck(AGREED, JSON.stringify({ task: 't', acceptance: [...ITEMS, 'an item the skill added'], witnesses: WITNESSES, invariants: INVARIANTS }))

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('stops when an agreed item carries no witness in the brief', () => {
    const result = runCheck('Acceptance: the reader parses the file', JSON.stringify({ task: 't', acceptance: ['the reader parses the file'], witnesses: [{ criterion: 'the reader parses the file', command: 'true' }] }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no witness in the brief: the reader parses the file')
  })

  it('stops when the args carry a witness other than the brief\'s, such as a tautology', () => {
    const substituted = WITNESSES.map((witness, index) => index === 1 ? { ...witness, command: 'test -f b.mjs' } : witness)
    const result = runCheck(AGREED, JSON.stringify({ task: 't', acceptance: ITEMS, witnesses: substituted, invariants: INVARIANTS }))

    expect(result.status).toBe(1)
    expect(result.stderr.split('\n').filter(Boolean)).toEqual([`the witness in the args is not the brief's: ${ITEMS[1]}`])
  })

  it('stops when an agreed invariant is missing from the args', () => {
    const result = runCheck(AGREED, JSON.stringify({ task: 't', acceptance: ITEMS, witnesses: WITNESSES }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`invariant missing from the args: ${INVARIANTS[0]}`)
  })

  it('passes and says so when the agreed line has no Acceptance section', () => {
    const result = runCheck('/implement add a rule', JSON.stringify({ task: 't', acceptance: ['anything'] }))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('nothing was agreed to check')
  })

  it('exits 2 with the reason on malformed args JSON', () => {
    const result = runCheck(AGREED, '{"acceptance": [')

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('not valid JSON')
  })

  it('exits 2 with the reason on an unreadable file', () => {
    const child = spawnSync(process.execPath, [SCRIPT, '--agreed', path.join(tmpdir(), 'no-such-agreed-line.txt'), '--args', path.join(tmpdir(), 'no-such-args.json')], { encoding: 'utf8' })

    expect(child.status).toBe(2)
    expect(child.stderr).toContain('cannot read')
  })
})
