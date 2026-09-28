import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashBrief } from '../../ghosts/hash.js'

function worldDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ghosts-hash-'))
}

describe('hashBrief', () => {
  it('hashes from the /implement line to the end of the file, its last line included', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    const text = '/implement Hash me.\n\nDesign:\n- the last line'
    writeFileSync(brief, `# head\n\nprose before the text\n\n---\n\n${text}`)

    const hash = hashBrief(brief)
    expect(hash).toBe(createHash('sha256').update(text).digest('hex'))
    expect(hash).not.toBe(createHash('sha256').update(text.slice(0, text.lastIndexOf('\n'))).digest('hex'))
  })

  it('refuses a brief with no /implement line, naming it', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    writeFileSync(brief, '# no marker\n')

    expect(() => hashBrief(brief)).toThrow(brief)
  })
})
