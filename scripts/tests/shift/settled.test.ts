import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { settled } from './fixtures/settled.js'

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'settled-'))
  dirs.push(dir)
  return path.join(dir, 'pid')
}

function later(ms: number, write: () => void): void {
  setTimeout(write, ms)
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('settled', () => {
  it('a file already holding a complete line resolves to it trimmed', async () => {
    const file = scratch()
    writeFileSync(file, '4917\n')
    expect(await settled(file)).toBe('4917')
  })

  it('a file created empty and filled after 300ms resolves to the filled value', async () => {
    const file = scratch()
    writeFileSync(file, '')
    later(300, () => writeFileSync(file, '48474\n'))
    expect(await settled(file, 5_000)).toBe('48474')
  })

  it('a line still missing its newline is waited for until it completes', async () => {
    const file = scratch()
    writeFileSync(file, '48')
    later(300, () => writeFileSync(file, '48474\n'))
    expect(await settled(file, 5_000)).toBe('48474')
  })

  it('a file that never appears rejects with an error naming the file', async () => {
    const file = scratch()
    await expect(settled(file, 200)).rejects.toThrow(new RegExp(`${file} did not settle .* within \\d+ms`))
  })

  it('a file that stays empty rejects with the time waited', async () => {
    const file = scratch()
    writeFileSync(file, '')
    await expect(settled(file, 200)).rejects.toThrow(/within (2\d\d|[3-9]\d\d|\d{4,})ms/)
  })
})
