import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROMPTS_DIR, promptsDirOf, sha256, storedInput } from '../../bus/prompt-store.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-prompts-'))
  roots.push(root)
  return root
}

describe('the prompt store', () => {
  it('stores a prompt under its sha256 and names the sha and the path', () => {
    const prompts = path.join(tempRoot(), PROMPTS_DIR)
    const stored = storedInput(prompts, { prompt: 'a prompt' })

    expect(stored).toEqual({ prompt_sha: sha256('a prompt'), prompt_path: path.join(prompts, `${sha256('a prompt')}.md`) })
    expect(readFileSync(path.join(prompts, `${sha256('a prompt')}.md`), 'utf8')).toBe('a prompt')
  })

  it('records nothing without a prompts directory or without an input', () => {
    expect(storedInput(undefined, { prompt: 'a prompt' })).toEqual({})
    expect(storedInput(tempRoot(), undefined)).toEqual({})
  })

  it('a prompt that cannot be written keeps its sha and names why it was not stored', () => {
    const blocker = path.join(tempRoot(), 'a-file')
    writeFileSync(blocker, '')
    const stored = storedInput(path.join(blocker, PROMPTS_DIR), { prompt: 'a prompt' })

    expect(stored).toMatchObject({ prompt_sha: sha256('a prompt'), prompt_unstored: expect.any(String) as unknown })
    expect(stored).not.toHaveProperty('prompt_path')
  })

  it('the prompts directory sits beside the bus database', () => {
    expect(promptsDirOf('/home/.construct/bus.db')).toBe(path.join('/home/.construct', PROMPTS_DIR))
  })
})
