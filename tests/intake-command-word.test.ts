import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { unresolvedCommandWord as attachResolves } from '../src/commands/attach/harness.js'
import { commandWord, unresolvedCommandWord } from '../src/commands/intake/command-word.js'

const INTAKE = path.join(import.meta.dirname, '..', 'src', 'commands', 'intake')
const IMPORT_FROM_ATTACH = /from\s+'\.\.\/attach\//

describe('resolving a command word has one home both commands import', () => {
  it('no file under src/commands/intake imports from src/commands/attach', () => {
    const reaching = readdirSync(INTAKE, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts'))
      .filter(file => IMPORT_FROM_ATTACH.test(readFileSync(path.join(INTAKE, file), 'utf8')))
    expect(reaching).toEqual([])
  })

  it('attach resolves a harness command through the same function intake uses', () => {
    expect(attachResolves).toBe(unresolvedCommandWord)
  })

  it('the command word skips leading environment assignments', () => {
    expect(commandWord('CI=1 NODE_ENV=test vitest run')).toBe('vitest')
  })
})
