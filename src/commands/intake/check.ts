import type { Kind } from '../../card/grammar.js'
import type { DraftCard, UnclearField } from './draft.js'
import type { RepositoryFacts } from './facts.js'
import { CONTOURS, decisionsOf, KINDS } from '../../card/grammar.js'
import { createdPaths, parseCreatesEntry } from '../../card/parking.js'
import { PREFIX_SUFFIX, touchError } from '../../card/task-file.js'
import { commandWord } from './command-word.js'

export const DEFAULT_CONTOUR = 'ladder'
export const CARD_REFERENCE = /^#(\d+)$/
const BACKTICKED = /`([^`]+)`/g
const TEST_NAME_ARGUMENT = /(?:^|\s)(?:-t|--testNamePattern)(?:=|\s+)(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g
const FIELD_ORDER = ['number', 'contour', 'decision', 'touches', 'creates', 'depends', 'blocks']

const HARNESS_MEMBERSHIP_TEST = 'tests/harness-membership.test.ts'
const TESTS_ROOT = 'tests'
const SOURCE_MODULE = /^src\/(.+)\.ts$/

export interface CompanionRow {
  kind: string
  keptBy: string
  touched: (entry: string) => boolean
  companions: (entry: string, touches: readonly string[], repository: RepositoryFacts) => string[]
}

function scopeOf(entry: string): string {
  return entry.endsWith(PREFIX_SUFFIX) ? entry.slice(0, -PREFIX_SUFFIX.length) : entry
}

function under(entry: string, root: string): boolean {
  const scope = scopeOf(entry)
  return scope === root || scope.startsWith(`${root}/`)
}

function testBeside(entry: string, touches: readonly string[], repository: RepositoryFacts): string[] {
  if (touches.some(touch => under(touch, TESTS_ROOT)))
    return []
  const module = SOURCE_MODULE.exec(entry)?.[1]
  const mirrored = `${TESTS_ROOT}/${module}.test.ts`
  return [module !== undefined && repository.exists(mirrored) ? mirrored : `${TESTS_ROOT}${PREFIX_SUFFIX}`]
}

export const COMPANION_TABLE: readonly CompanionRow[] = [
  { kind: 'the scripts manifest', keptBy: HARNESS_MEMBERSHIP_TEST, touched: entry => entry === 'package.json', companions: () => ['CONTRIBUTING.md', HARNESS_MEMBERSHIP_TEST] },
  { kind: 'the command definitions', keptBy: 'tests/readme-commands.test.ts', touched: entry => entry === 'src/program.ts', companions: () => ['README.md', 'docs/cli.md', `docs/guide${PREFIX_SUFFIX}`] },
  { kind: 'published code', keptBy: '.changeset/config.json', touched: entry => under(entry, 'src') || under(entry, 'templates'), companions: () => [`.changeset${PREFIX_SUFFIX}`] },
  { kind: 'source code', keptBy: TESTS_ROOT, touched: entry => under(entry, 'src'), companions: testBeside },
]
export const COMPANION_REASON = 'every change of this kind carries it: the companion table in src/commands/intake/check.ts'

export interface Correction {
  field: string
  was: string
  now: string
  reason: string
}

export interface CheckedCard extends DraftCard {
  corrections: Correction[]
}

export interface CheckFacts {
  taken: ReadonlySet<number>
  parked: ReadonlySet<number>
  done: ReadonlySet<string>
  merged: ReadonlySet<string>
  repository: RepositoryFacts
}

export function correctionText(correction: Correction): string {
  return `${correction.field} — ${correction.was} → ${correction.now} — ${correction.reason}`
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

function numberCorrection(card: DraftCard, assigned: number, facts: CheckFacts): Correction[] {
  const named = card.number
  if (named === undefined || named === assigned)
    return []
  const reason = facts.taken.has(named)
    ? `#${named} is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake`
    : facts.parked.has(named)
      ? `#${named} is taken by the parked card ${named}.md; numbers are assigned by construct intake`
      : 'numbers are assigned by construct intake, the next free after every number taken; a named number is never used'
  return [{ field: 'number', was: `#${named}`, now: `#${assigned}`, reason }]
}

function contourCorrection(card: DraftCard): Correction[] {
  if (card.contour === undefined || includes(CONTOURS, card.contour))
    return []
  return [{ field: 'contour', was: card.contour, now: DEFAULT_CONTOUR, reason: `'${card.contour}' is not one of ${CONTOURS.join(', ')}; ${DEFAULT_CONTOUR} is the path with a brief and witnesses` }]
}

function decisionCorrection(card: DraftCard): Correction[] {
  if (card.decision === undefined || !includes(KINDS, card.kind))
    return []
  const decisions: readonly string[] = decisionsOf(card.kind as Kind)
  if (includes(decisions, card.decision))
    return []
  return [{ field: 'decision', was: card.decision, now: decisions[0]!, reason: `kind ${card.kind} takes decision ${decisions.join(' or ')}, not ${card.decision}` }]
}

function candidatesText(candidates: readonly string[]): string {
  return candidates.length === 0 ? 'no path is' : `${candidates.length} paths: ${candidates.join(', ')} are`
}

interface Touched {
  touches: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function touchesChecked(card: DraftCard, repository: RepositoryFacts): Touched {
  const touched: Touched = { touches: [], corrections: [], unclear: [] }
  const creates = createdPaths(card.creates)
  for (const parsed of card.creates.map(parseCreatesEntry)) {
    if (parsed.kind === 'refused')
      touched.unclear.push({ field: 'creates', reason: parsed.reason })
  }
  for (const entry of card.touches) {
    if (touchError(entry) !== null) {
      touched.touches.push(entry)
      continue
    }
    const created = creates.includes(entry)
    const prefix = entry.endsWith(PREFIX_SUFFIX) ? PREFIX_SUFFIX : ''
    const scope = prefix === '' ? entry : entry.slice(0, -PREFIX_SUFFIX.length)
    if (repository.exists(scope)) {
      touched.touches.push(entry)
      if (created)
        touched.corrections.push({ field: 'creates', was: entry, now: '(exists, not new)', reason: `${entry} already exists` })
      continue
    }
    const segment = scope.slice(scope.lastIndexOf('/') + 1)
    const candidates = created ? [] : repository.pathsNamed(segment)
    if (candidates.length === 1) {
      touched.touches.push(`${candidates[0]}${prefix}`)
      touched.corrections.push({ field: 'touches', was: entry, now: `${candidates[0]}${prefix}`, reason: `'${scope}' does not exist; '${candidates[0]}' is the only path named '${segment}'` })
      continue
    }
    touched.touches.push(entry)
    if (!created)
      touched.unclear.push({ field: 'touches', reason: `'${scope}' does not exist and ${candidatesText(candidates)} named '${segment}'; list it under creates if the change makes it` })
  }
  return touched
}

function covers(touch: string, companion: string): boolean {
  return touch === companion || (touch.endsWith(PREFIX_SUFFIX) && under(companion, scopeOf(touch)))
}

function withCompanions(touched: Touched, repository: RepositoryFacts): Touched {
  const missing: string[] = []
  for (const row of COMPANION_TABLE) {
    if (!repository.exists(row.keptBy))
      continue
    for (const entry of touched.touches.filter(row.touched)) {
      const touches = [...touched.touches, ...missing]
      for (const companion of row.companions(entry, touches, repository)) {
        if (repository.exists(scopeOf(companion)) && !touches.some(touch => covers(touch, companion)))
          missing.push(companion)
      }
    }
  }
  return {
    ...touched,
    touches: [...touched.touches, ...missing],
    corrections: [...touched.corrections, ...missing.map(companion => ({ field: 'touches', was: '(absent)', now: companion, reason: COMPANION_REASON }))],
  }
}

interface Linked {
  kept: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function referencesChecked(field: 'depends' | 'blocks', references: readonly string[], facts: CheckFacts): Linked {
  const linked: Linked = { kept: [], corrections: [], unclear: [] }
  for (const reference of references) {
    const id = CARD_REFERENCE.exec(reference)?.[1]
    if (id === undefined) {
      linked.kept.push(reference)
    }
    else if (facts.merged.has(id)) {
      linked.corrections.push({ field, was: reference, now: '(removed)', reason: 'already merged' })
    }
    else {
      linked.kept.push(reference)
      if (!facts.parked.has(Number(id)) && !facts.done.has(id))
        linked.unclear.push({ field, reason: `'${reference}' is neither a parked card, done nor merged in the journal` })
    }
  }
  return linked
}

function witnessesUnclear(card: DraftCard, repository: RepositoryFacts): UnclearField[] {
  return card.witnesses.flatMap((witness) => {
    const words = [...witness.matchAll(BACKTICKED)].flatMap(match => commandWord(match[1]!) || [])
    if (words.length === 0)
      return [{ field: 'witnesses', reason: `'${witness.trim()}' names no command; a witness is run by a command` }]
    return [...new Set(words)]
      .filter(word => !repository.commandResolves(word))
      .map(word => ({ field: 'witnesses', reason: `'${word}' is not on PATH and is no file of the repository` }))
  })
}

function testNamePatterns(witness: string): string[] {
  return [...witness.matchAll(BACKTICKED)].flatMap(command => [...command[1]!.matchAll(TEST_NAME_ARGUMENT)].map(match => match[1] ?? match[2]?.replace(/\\([\\"$`])/g, '$1') ?? match[3]!))
}

export function invalidTestPatterns(cards: readonly DraftCard[]): string[] {
  return cards.flatMap(card => card.witnesses.flatMap(witness => testNamePatterns(witness).flatMap((pattern) => {
    try {
      return new RegExp(pattern, '') && []
    }
    catch (error) {
      return [`${witness.trim()} — ${error instanceof Error ? error.message : String(error)}`]
    }
  })))
}

function byFieldOrder(corrections: Correction[]): Correction[] {
  return [...corrections].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))
}

function checkCard(card: DraftCard, assigned: number, facts: CheckFacts): CheckedCard {
  const touched = withCompanions(touchesChecked(card, facts.repository), facts.repository)
  const depends = referencesChecked('depends', card.depends, facts)
  const blocks = referencesChecked('blocks', card.blocks, facts)
  const contour = contourCorrection(card)
  const decision = decisionCorrection(card)
  return {
    ...card,
    contour: contour[0]?.now ?? card.contour,
    decision: decision[0]?.now ?? card.decision,
    touches: touched.touches,
    depends: depends.kept,
    blocks: blocks.kept,
    unclear: [
      ...card.unclear,
      ...touched.unclear,
      ...depends.unclear,
      ...blocks.unclear,
      ...witnessesUnclear(card, facts.repository),
    ],
    corrections: byFieldOrder([
      ...numberCorrection(card, assigned, facts),
      ...contour,
      ...decision,
      ...touched.corrections,
      ...depends.corrections,
      ...blocks.corrections,
    ]),
  }
}

export function checkDraft(cards: readonly DraftCard[], numbers: readonly number[], facts: CheckFacts): CheckedCard[] {
  return cards.map((card, index) => checkCard(card, numbers[index]!, facts))
}
