import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const ROOT = 'scripts/intake/intake.ts'
const MODULE_FILE = 'scripts/intake/bus-intake.ts'
const READERS = ['busHeldCards', 'busCardAdmissions', 'busCardEvents', 'busIntakeAdmissions', 'IntakeAdmission', 'isOpenRelease'] as const

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^export (?:async )?(?:function|interface|const|class|type) ${symbol}\\b`, 'm').test(source)
}

describe('the intake root readers live in the intake module, not in its composition root', () => {
  it('bus-intake.ts declares the intake root readers and intake.ts declares none of them', () => {
    expect(existsSync(path.join(REPO_ROOT, MODULE_FILE))).toBe(true)
    const moduleSource = sourceOf(MODULE_FILE)
    const rootSource = sourceOf(ROOT)
    expect(READERS.filter(symbol => !declares(moduleSource, symbol))).toEqual([])
    expect(READERS.filter(symbol => declares(rootSource, symbol))).toEqual([])
  })
})
