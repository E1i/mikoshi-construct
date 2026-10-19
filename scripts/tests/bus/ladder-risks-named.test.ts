import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../..')
const testsRoot = path.join(root, 'scripts/tests')
const windowDoc = readFileSync(path.join(root, 'architecture/window.md'), 'utf8')
const LADDER_RISK_COUNT = 4
const WITNESS = /`([^`]+\.test\.ts)` › `([^`]+)`/g

function ladderRisks(doc: string): string[] {
  const section = doc.split('\n### The ladder\'s four risks\n')[1]?.split('\n#')[0] ?? ''
  return section.split(/\n(?=\d+\. )/).filter(item => /^\d+\. /.test(item))
}

function witnessesOf(risk: string): { file: string, title: string }[] {
  return [...risk.matchAll(WITNESS)].map(([, file, title]) => ({ file: file!, title: title! }))
}

describe('the ladder risks in window.md', () => {
  it('each ladder risk named in window.md has its witness title in its test file', () => {
    const risks = ladderRisks(windowDoc)
    expect(risks).toHaveLength(LADDER_RISK_COUNT)
    for (const risk of risks) {
      const witnesses = witnessesOf(risk)
      expect(witnesses, risk).not.toEqual([])
      for (const { file, title } of witnesses)
        expect(readFileSync(path.join(testsRoot, file), 'utf8'), `${file} › ${title}`).toContain(`it('${title}'`)
    }
  })
})
