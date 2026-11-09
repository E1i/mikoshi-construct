import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DUTIES = 'scripts/nodes/answer/duties/'
const EXECUTOR = 'scripts/nodes/answer/answer-executor.ts'
const ANSWERER = 'scripts/nodes/answer/answerer.ts'
const SCAN_TIMEOUT = 180_000
const ANSWER_DUTIES = CONCEPTS.filter(concept => concept.id === 'answer-duties')
const HELD_BY_THE_LIVE_SESSION_LIST = { [ANSWERER]: 1 }

const DUTY_FILES = [
  { duty: 'choosing the source', from: EXECUTOR, name: 'sourceOf', file: 'source.ts' },
  { duty: 'publishing', from: EXECUTOR, name: 'published', file: 'publishing.ts' },
  { duty: 'the stale question', from: EXECUTOR, name: 'staleQuestion', file: 'stale-question.ts' },
  { duty: 'outcomes', from: EXECUTOR, name: 'denied', file: 'outcomes.ts' },
  { duty: 'the prompt', from: ANSWERER, name: 'answerPrompt', file: 'prompt.ts' },
  { duty: 'the CI log', from: ANSWERER, name: 'redCiLines', file: 'prompt.ts' },
  { duty: 'reading the tree', from: ANSWERER, name: 'treeMergeOf', file: 'tree.ts' },
  { duty: 'running the client', from: ANSWERER, name: 'spawnClient', file: 'client.ts' },
] as const

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'answer-duties-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function declares(text: string, name: string): boolean {
  return new RegExp(`^\\s*(?:export )?(?:private )?(?:async )?(?:function )?${name}\\(`, 'm').test(text)
}

describe('the answer node keeps each duty in its own file under duties', () => {
  it('each duty lives in its own file under duties', () => {
    for (const { duty, name, file } of DUTY_FILES)
      expect(declares(readFileSync(path.join(REPO_ROOT, DUTIES, file), 'utf8'), name), `${duty}: ${name} in ${file}`).toBe(true)
  })

  it('the executor and the answerer declare no duty but the live session the liveness list holds in the answerer', { timeout: SCAN_TIMEOUT }, () => {
    expect(overlapsSection(findSites(REPO_ROOT, ANSWER_DUTIES), ANSWER_DUTIES)['answer-duties']).toEqual(HELD_BY_THE_LIVE_SESSION_LIST)
  })

  it('a duty declared back in the executor or the answerer is a site, and the same duty under duties is not', { timeout: SCAN_TIMEOUT }, () => {
    for (const { duty, from, name, file } of DUTY_FILES) {
      const declaration = `export function ${name}(): void {}\n`
      const back = treeWith({ [from]: declaration })
      const home = treeWith({ [`${DUTIES}${file}`]: declaration })

      expect(findSites(back, ANSWER_DUTIES).map(site => `${site.file} ${site.form}`), duty).toEqual([`${from} ${duty}: ${name}`])
      expect(findSites(home, ANSWER_DUTIES), duty).toEqual([])
    }
  })
})
