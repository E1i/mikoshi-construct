import type { WindowShard } from '../../policy/shards.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { busDownOf } from '../../cli/board-page.js'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { statusLineOf, statusOf, statusOfFile } from '../../core/handoff-status.js'
import { ownerUnderDecisionsShardRefusal } from '../../window/handoff-write.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const OWNER = 'scripts/core/handoff-status.ts'
const PLANTED_FILE = 'scripts/window/planted.ts'
const SCAN_TIMEOUT = 180_000
const SRC_MAY_NOT_IMPORT_THE_OWNER_YET = ['src/commands/doctor/factory.ts']
const STATUS_CONCEPTS = CONCEPTS.filter(concept => concept.id === 'handoff-status')
const SHARD: WindowShard = { id: 'ws-1', by: 'Eli', scope: 'merge+decisions', until: '2026-10-17T16:00:00.000Z' }
const OWNER_QUESTION = 'STATUS: OWNER — boundary: owner-question'

const PLANTED: readonly (readonly [string, string])[] = [
  ['a regex over the STATUS line', 'export const LINE = /^STATUS:\\s*(CONTINUE|OWNER)\\b/'],
  ['the label STATUS', 'export const LABEL = \'STATUS\''],
  ['a statusOf over a read', 'import { readFileSync } from \'node:fs\'\ndeclare function statusOf(text: string): string\nexport const status = statusOf(readFileSync(\'miko.md\', \'utf8\'))'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'handoff-status-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function filesWithSites(root: string): string[] {
  return Object.keys(overlapsSection(findSites(root, STATUS_CONCEPTS), STATUS_CONCEPTS)['handoff-status']!).sort()
}

function handoff(lines: readonly string[]): string {
  return ['# miko', 'current card: #1655', ...lines, ''].join('\n')
}

describe('the STATUS line of a handoff', () => {
  it('the last STATUS line of a handoff is the status', () => {
    const ownerThenContinue = handoff(['STATUS: OWNER — boundary: owner-question', 'note: answered', 'STATUS: CONTINUE'])
    const continueThenOwner = handoff(['STATUS: CONTINUE', OWNER_QUESTION])

    expect(statusOf(ownerThenContinue)).toBe('CONTINUE')
    expect(statusOf(continueThenOwner)).toBe('OWNER')
    expect(statusLineOf(continueThenOwner)).toEqual({ status: 'OWNER', line: OWNER_QUESTION, value: 'OWNER — boundary: owner-question' })
    expect(statusOf(handoff(['- STATUS: OWNER', 'STATUS: MAYBE']))).toBeNull()

    const now = new Date('2026-11-08T00:00:00.000Z')
    const missingSnapshot = path.join(treeWith({}), 'snapshot.json')
    expect(busDownOf(now, 'down', missingSnapshot, { file: 'miko.md', text: ownerThenContinue }).handoffStatus).toBeNull()
    expect(busDownOf(now, 'down', missingSnapshot, { file: 'miko.md', text: continueThenOwner }).handoffStatus).toBe('OWNER — boundary: owner-question')

    const root = treeWith({ 'miko.md': continueThenOwner })
    expect(statusOfFile(path.join(root, 'miko.md'))).toBe('OWNER')
    expect(statusOfFile(path.join(root, 'absent.md'))).toBeUndefined()
  })

  it('a STATUS parse outside the owner is red', { timeout: SCAN_TIMEOUT }, () => {
    for (const [label, text] of PLANTED)
      expect(filesWithSites(treeWith({ [PLANTED_FILE]: text })), label).toEqual([PLANTED_FILE])
    expect(filesWithSites(treeWith({ [OWNER]: PLANTED.map(([, text]) => text).join('\n') }))).toEqual([])

    expect(filesWithSites(REPO_ROOT)).toEqual(SRC_MAY_NOT_IMPORT_THE_OWNER_YET)
  })

  it('sTATUS OWNER is accepted under a shard when the handoff names owner items', () => {
    const named = handoff(['owner waits: Q7 answered; Q12 open', OWNER_QUESTION])
    const answeredOnly = handoff(['owner waits: Q7 answered', OWNER_QUESTION])
    const none = handoff(['owner waits: none', 'question: which path?', OWNER_QUESTION])

    expect(ownerUnderDecisionsShardRefusal(named, SHARD)).toBeNull()
    expect(ownerUnderDecisionsShardRefusal(answeredOnly, SHARD)).toContain('under the active merge+decisions shard ws-1')
    expect(ownerUnderDecisionsShardRefusal(none, SHARD)).toContain('under the active merge+decisions shard ws-1')
    expect(ownerUnderDecisionsShardRefusal(named, null)).toBeNull()
  })
})
