import type { WitnessField } from '../../src/card/witness-fields.js'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { LAYER_MAP, readLayerMap } from '../../scripts/core/layer-map.js'
import { cardWitnessesOf } from '../../scripts/policy/policy.js'
import { layerMasksOf, runsOf } from '../../src/card/covering-tests.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { fieldCommand, judgedCommand, layerEntryRefusals, renderedWitness, witnessFieldsLine, witnessFieldsOf, witnessText } from '../../src/card/witness-fields.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { amendedText } from '../../src/commands/intake/amend.js'
import { checkDraft, isChangeWitness, unjudgedCommand } from '../../src/commands/intake/check.js'
import { parseDraft } from '../../src/commands/intake/draft.js'
import { sliceCards } from '../../src/commands/intake/slice.js'
import { factoryAssets } from '../../tsup.config.js'

const RUN = 'pnpm exec vitest run tests/a.test.ts'
const FIELD: WitnessField = { id: 'W1', run: RUN, test: 'the thing', head: 'pass', base: 'fail', proves: 'the thing is done' }
const CARD = '#80 thing [implement/construct/S/cheap/auto] · depends — · blocks —'

function cardText(body: string): string {
  return `card: ${CARD}\nbranch: feat/thing\ntouches: src/board/run.ts\ncontinue: stop\nwho: shift\n\n${body}\n`
}

function draftOf(witnesses: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ cards: [{ name: 'thing', kind: 'implement', milestone: 'construct', size: 'S', touches: ['src/board/run.ts'], task: 'Do the thing.', witnesses, ...extra }] })
}

const REPOSITORY = {
  exists: () => true,
  pathsNamed: () => [],
  commandResolves: () => true,
  testsCovering: () => [],
}

function slicedText(draftText: string): string {
  const draft = parseDraft(draftText)
  if (draft.kind !== 'draft')
    throw new Error(draft.reasons.join('; '))
  const checked = checkDraft(draft.cards, [80], { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository: REPOSITORY })
  const sliced = sliceCards(checked, [80], { filesUnder: () => [], read: () => null })
  if (sliced.kind !== 'sliced')
    throw new Error(sliced.reasons.join('; '))
  return sliced.cards[0]!.text
}

function statusOf(command: string): number | null {
  return spawnSync('bash', ['-c', command], { cwd: tmpdir() }).status
}

describe('the witness fields of a card', () => {
  it('a card with fields and no Witnesses prose passes the grammar', () => {
    const text = slicedText(draftOf([FIELD], { runs: ['tests/card/**'] }))
    expect(text).not.toContain('Witnesses:')
    const parsed = parseParkingFile('80.md', text)
    expect(parsed.kind).toBe('parked')
    expect(witnessFieldsOf(text)).toEqual([FIELD])
    expect(witnessesOf(text)).toEqual([witnessText(FIELD)])
    expect(runsOf(text)).toEqual(['tests/card/**'])
  })

  it('a field witness needs a run and head exit:1 means exit 1', () => {
    const { run: _run, ...withoutRun } = FIELD
    const refused = parseParkingFile('80.md', cardText(`Do it.\n\n${witnessFieldsLine([withoutRun])}`))
    expect(refused).toMatchObject({ kind: 'refused', reason: expect.stringContaining('has no run') })
    expect(parseDraft(draftOf([withoutRun]))).toMatchObject({ kind: 'refused', reasons: [expect.stringContaining('has no run')] })

    const judged = (run: string): string => judgedCommand({ ...FIELD, run, test: null, head: 'exit:1', base: 'pass' })
    expect(statusOf(judged('exit 1'))).toBe(0)
    expect(statusOf(judged('exit 0'))).not.toBe(0)
    expect(statusOf(judged('exit 2'))).not.toBe(0)
    expect(statusOf(judged('exit 1;'))).toBe(0)
  })

  it.each([
    ['an id out of form', { id: 'one' }, 'W1, W2'],
    ['an expectation out of form', { head: 'exits 0' }, 'pass, fail or exit:N'],
    ['exit:0, which is pass', { head: 'exit:0' }, 'pass, fail or exit:N'],
    ['a run with a backtick', { run: 'echo `date`', test: null }, 'no backtick'],
    ['no proves', { proves: '' }, 'proves'],
    ['an unknown key', { note: 'x' }, 'unknown key'],
    ['a test name beside a run that names one', { run: `${RUN} -t 'x'` }, 'not both'],
    ['a test name on a run that is no vitest run', { run: 'test -f a' }, 'no vitest run'],
    ['a test name with a single quote', { test: 'it\'s' }, 'single quote'],
    ['a test name with a backtick', { test: 'the `thing`' }, 'no backtick'],
    ['a negated run with an exit', { run: `! ${RUN}`, test: null, head: 'exit:1' }, 'negated run'],
  ])('refuses %s', (_name, change, reason) => {
    expect(parseParkingFile('80.md', cardText(`Do it.\n\n${witnessFieldsLine([{ ...FIELD, ...change }])}`))).toMatchObject({ kind: 'refused', reason: expect.stringContaining(reason) })
  })

  it('refuses a repeated id, an empty list, a repeated line and a runs field that is no list of paths', () => {
    const refusedFor = (body: string): unknown => parseParkingFile('80.md', cardText(`Do it.\n\n${body}`))
    expect(refusedFor(witnessFieldsLine([FIELD, FIELD]))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('more than one field') })
    expect(refusedFor(witnessFieldsLine([]))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('at least one') })
    expect(refusedFor(`${witnessFieldsLine([FIELD])}\n${witnessFieldsLine([FIELD])}`)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('appears twice') })
    expect(refusedFor('runs: [1]')).toMatchObject({ kind: 'refused', reason: expect.stringContaining('list of paths') })
    expect(refusedFor('witnesses: [not json')).toMatchObject({ kind: 'refused' })
  })

  it('a draft mixes field witnesses and text witnesses in no card', () => {
    expect(parseDraft(draftOf([FIELD, '`test -f a` exits 0']))).toMatchObject({ kind: 'refused', reasons: [expect.stringContaining('not both')] })
  })

  it('a prose line that only mentions the fields is no field', () => {
    const body = 'The grammar is witnesses: [{id: W1}] in the card.\n\nWitnesses:\n- `test -f a` exits 0'
    expect(parseParkingFile('80.md', cardText(body)).kind).toBe('parked')
    expect(witnessesOf(body)).toEqual(['`test -f a` exits 0'])
  })

  it('fields come first when a card also keeps Witnesses prose as explanation', () => {
    const body = `Do it.\n\n${witnessFieldsLine([FIELD])}\n\nWitnesses:\n- \`test -f prose\` exits 0`
    expect(witnessesOf(body)).toEqual([witnessText(FIELD)])
    expect(cardWitnessesOf(body).acceptance.map(witness => witness.command)).toEqual([fieldCommand(FIELD)])
  })

  it('the text of a field states its acceptance kind and reads back as its id and command', () => {
    expect(isChangeWitness(witnessText(FIELD))).toBe(true)
    expect(isChangeWitness(witnessText({ ...FIELD, base: 'pass' }))).toBe(false)
    expect(renderedWitness(witnessText(FIELD))).toEqual({ id: 'W1', command: `${RUN} -t 'the thing'`, head: 'pass', base: 'fail' })
    expect(renderedWitness('`test -f a` exits 0')).toBeNull()
  })

  it('an acceptance field that names no path is unclear as a red-on-base check, where an invariant is not', () => {
    const facts = { taken: new Set<number>(), parked: new Set<number>(), done: new Set<string>(), merged: new Set<string>(), repository: { ...REPOSITORY, exists: (file: string) => file.startsWith('src/') } }
    const unclearOf = (field: WitnessField): string[] => {
      const draft = parseDraft(draftOf([field]))
      if (draft.kind !== 'draft')
        throw new Error(draft.reasons.join('; '))
      return checkDraft(draft.cards, [80], facts)[0]!.unclear.map(entry => entry.reason)
    }
    const wholeTree = { ...FIELD, run: 'pnpm run quality', test: null }
    expect(unclearOf(wholeTree)).toEqual([expect.stringContaining('to be red on the base')])
    expect(unclearOf({ ...wholeTree, base: 'pass' })).toEqual([])
  })

  it('a layer entry parks beside paths, passes intake with nothing unclear and stays out of the paths', () => {
    const text = slicedText(draftOf([FIELD], { runs: ['layer:core', 'tests/card/**'] }))
    expect(text).toContain('runs: ["layer:core","tests/card/**"]')
    expect(parseParkingFile('80.md', text).kind).toBe('parked')
    expect(runsOf(text)).toEqual(['tests/card/**'])
    expect(layerMasksOf(text)).toEqual(['core'])
  })

  it('a layer entry whose id the layer map does not hold is refused, and a card with none reads no masks', () => {
    expect(parseParkingFile('80.md', cardText('Do it.\n\nruns: ["layer:no-such-layer"]'))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('names no layer') })
    expect(parseParkingFile('80.md', cardText('Do it.\n\nruns: ["layer:"]'))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('names no layer') })
    expect(layerMasksOf(cardText('Do it.\n\nruns: ["tests/card/**"]'))).toEqual([])
  })

  it('the layer ids a card may name are exactly the ids readLayerMap reads, because src/card may not import it', () => {
    const { files, folders } = readLayerMap()
    const ids = [...Object.values(files), ...Object.values(folders)]
    expect(ids.length).toBeGreaterThan(0)
    expect(layerEntryRefusals(ids.map(id => `layer:${id}`))).toEqual([])
    expect(factoryAssets()).toContain(LAYER_MAP)
  })

  it('a missing layer map refuses a layer entry by that cause, not as an unknown layer', () => {
    const refusals = layerEntryRefusals(['layer:core'], [tmpdir()])
    expect(refusals).toEqual([expect.stringContaining('cannot be checked')])
    expect(refusals[0]).not.toContain('names no layer')
    expect(layerEntryRefusals([], [tmpdir()])).toEqual([])
  })

  it('a runs field outside the test trees is unclear', () => {
    const draft = parseDraft(draftOf([FIELD], { runs: ['src/board/**'] }))
    if (draft.kind !== 'draft')
      throw new Error(draft.reasons.join('; '))
    const [checked] = checkDraft(draft.cards, [80], { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository: REPOSITORY })
    expect(checked!.unclear.map(entry => entry.field)).toEqual(['runs'])
  })
})

describe('the policy reads head and base from the fields', () => {
  const judged = (field: Partial<WitnessField>): ReturnType<typeof cardWitnessesOf> => cardWitnessesOf(`Do it.\n\n${witnessFieldsLine([{ ...FIELD, test: null, ...field }])}`)

  it('head pass over base fail is an acceptance of the command itself', () => {
    expect(judged({}).acceptance.map(witness => witness.command)).toEqual([RUN])
  })

  it('head fail over base pass is an acceptance of the negated command, and of the bare one when the run is negated', () => {
    expect(judged({ head: 'fail', base: 'pass' }).acceptance.map(witness => witness.command)).toEqual([`! ( ${RUN}\n)`])
    expect(judged({ run: `! ${RUN}`, head: 'fail', base: 'pass' }).acceptance.map(witness => witness.command)).toEqual([RUN])
  })

  it('an acceptance with an exit in it carries the bare command and the stated base, and no other witness does', () => {
    expect(judged({ base: 'exit:3' }).acceptance).toMatchObject([{ command: RUN, onBase: { command: RUN, stated: 'exit:3' } }])
    expect(judged({ head: 'exit:3', base: 'fail' }).acceptance).toMatchObject([{ onBase: { command: RUN, stated: 'fail' } }])
    expect(judged({}).acceptance[0]).not.toHaveProperty('onBase')
    expect(judged({ head: 'exit:3', base: 'exit:3' }).invariants[0]).not.toHaveProperty('onBase')
  })

  it('unjudgedCommand opens the exit wrap and leaves any other command as it is', () => {
    expect(unjudgedCommand(judgedCommand({ ...FIELD, test: null, head: 'exit:3' }))).toBe(RUN)
    expect(unjudgedCommand(judgedCommand({ ...FIELD, test: null, head: 'fail', base: 'pass' }))).toBe(RUN)
    expect(unjudgedCommand(RUN)).toBe(RUN)
  })

  it('head fail negates a compound run whole, and a literal exit in it does not escape', () => {
    const failing = (run: string): string => judgedCommand({ ...FIELD, run, test: null, head: 'fail', base: 'pass' })
    expect(statusOf(failing('true; exit 3'))).toBe(0)
    expect(statusOf(failing('false; true'))).not.toBe(0)
    expect(statusOf(failing('false || exit 3'))).toBe(0)
  })

  it('the same head and base is an invariant', () => {
    expect(judged({ base: 'pass' })).toMatchObject({ acceptance: [], invariants: [{ command: RUN }] })
    expect(judged({ head: 'exit:3', base: 'exit:3' }).invariants.map(witness => witness.command)).toEqual([`( ${RUN}\n); test $? -eq 3`])
  })
})

describe('amending a card with fields', () => {
  const text = cardText(`Do it.\n\n${witnessFieldsLine([FIELD])}`)

  it('--witness replaces the field its id names', () => {
    const next = { ...FIELD, test: 'the thing exactly' }
    const edited = amendedText(text, { witness: `W1=${JSON.stringify(next)}` })
    expect(edited.kind).toBe('edited')
    expect(witnessFieldsOf(edited.kind === 'edited' ? edited.text : '')).toEqual([next])
  })

  it('--witness refuses an unknown id and a value that is not JSON', () => {
    expect(amendedText(text, { witness: 'W2={}' })).toMatchObject({ kind: 'refused', why: expect.stringContaining('the id one of W1') })
    expect(amendedText(text, { witness: 'W1=not json' })).toMatchObject({ kind: 'refused', why: expect.stringContaining('not JSON') })
  })
})
