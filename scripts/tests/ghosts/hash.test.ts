import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { hashBrief } from '../../ghosts/hash.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HASH = path.join(REPO_ROOT, 'scripts/ghosts/hash.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

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

describe('ghosts:hash from the command line', () => {
  it('prints the hash when started through a symlink to the script', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    writeFileSync(brief, '/implement Hash me.\n')
    const link = path.join(dir, 'hash.ts')
    symlinkSync(HASH, link)

    const result = spawnSync(process.execPath, [TSX_CLI, link, brief], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(hashBrief(brief))
  })
})
