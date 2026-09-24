import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CONTRIBUTING = readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
const CODE_MATRIX = 'architecture/code-matrix.md'

function paragraphLinking(text: string, target: string): string {
  return text.split(/\n{2,}/).find(paragraph => paragraph.includes(`](${target})`)) ?? ''
}

describe('an outside contributor is told the maintainer\'s evidence rituals are not asked of them', () => {
  it('says in one paragraph that the matrix, the predictions and the mutations are not required, and links where they are defined', () => {
    const paragraph = paragraphLinking(CONTRIBUTING, CODE_MATRIX)
    expect(paragraph, `CONTRIBUTING.md has no paragraph linking ${CODE_MATRIX}`).not.toBe('')
    expect(paragraph).toMatch(/matrix/i)
    expect(paragraph).toMatch(/prediction/i)
    expect(paragraph).toMatch(/mutation/i)
    expect(paragraph).toMatch(/not (?:required|asked)/i)
    expect(existsSync(path.join(REPO_ROOT, CODE_MATRIX))).toBe(true)
  })

  it('points back from the matrix convention to the contributor guide, where an outside reader arrives from', () => {
    const matrix = readFileSync(path.join(REPO_ROOT, CODE_MATRIX), 'utf8')
    expect(paragraphLinking(matrix, '../CONTRIBUTING.md')).toMatch(/not (?:required|asked)/i)
  })
})
