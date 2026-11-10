import type { Deadline } from './fixtures/settled.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { settled } from './fixtures/settled.js'

const WAITED_MS = 200

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'settled-'))
  dirs.push(dir)
  return path.join(dir, 'pid')
}

function heldDeadline(): Deadline & { expire: () => void } {
  const controller = new AbortController()
  return { signal: controller.signal, waited: () => WAITED_MS, expire: () => controller.abort() }
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

  it('a file created empty and filled later resolves to the filled value', async () => {
    const file = scratch()
    writeFileSync(file, '')
    const pending = settled(file, 5_000)
    writeFileSync(file, '48474\n')
    expect(await pending).toBe('48474')
  })

  it('a line still missing its newline is waited for until it completes', async () => {
    const file = scratch()
    writeFileSync(file, '48')
    const pending = settled(file, 5_000)
    writeFileSync(file, '48474\n')
    expect(await pending).toBe('48474')
  })

  it('a line completed just as the deadline passes still resolves', async () => {
    const file = scratch()
    const deadline = heldDeadline()
    writeFileSync(file, '48')
    const pending = settled(file, 5_000, () => '', deadline)
    writeFileSync(file, '48474\n')
    deadline.expire()
    expect(await pending).toBe('48474')
  })

  it('a file that never appears rejects with an error naming the file', async () => {
    const file = scratch()
    const deadline = heldDeadline()
    const pending = settled(file, 5_000, () => '', deadline)
    deadline.expire()
    await expect(pending).rejects.toThrow(new RegExp(`${file} did not settle .* within ${WAITED_MS}ms$`))
  })

  it('a file that stays empty rejects with the time waited and the diagnosis', async () => {
    const file = scratch()
    writeFileSync(file, '')
    const deadline = heldDeadline()
    const pending = settled(file, 5_000, () => 'the child exited', deadline)
    deadline.expire()
    await expect(pending).rejects.toThrow(`within ${WAITED_MS}ms; the child exited`)
  })

  it('a deadline already passed rejects at once', async () => {
    const file = scratch()
    const deadline = heldDeadline()
    deadline.expire()
    await expect(settled(file, 5_000, () => '', deadline)).rejects.toThrow(`within ${WAITED_MS}ms`)
  })
})
