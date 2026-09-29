import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGREED_TEXT_PATH, writeAgreedText } from '../../ghosts/agreed.js'

describe('writeAgreedText', () => {
  it('writes the approved text byte for byte where the implement skill builds its args from, creating .construct', () => {
    const worktree = mkdtempSync(path.join(tmpdir(), 'ghosts-agreed-'))
    const text = '/implement x\n\nWitness: `test -d a && ! grep -rEq b c`\n'
    const file = writeAgreedText(worktree, text)
    expect(file).toBe(path.join(worktree, AGREED_TEXT_PATH))
    expect(readFileSync(file, 'utf8')).toBe(text)
  })
})
