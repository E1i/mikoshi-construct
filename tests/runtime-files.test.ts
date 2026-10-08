import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWNED_ATLAS_PAGE } from '../src/atlas/index.js'
import { ATTACH_RUNTIME_BROWSER, ATTACH_RUNTIME_FILES, ATTACH_RUNTIME_RUN_DIRECTORY, ATTACH_RUNTIME_SHOT_SUFFIX, ATTACH_WRITES } from '../src/commands/attach/carriers.js'
import { ATTACH_RECORD_FILE } from '../src/commands/attach/record.js'
import { LEDGER_FILE, STEP_CACHE_FILE } from '../src/commands/cost/index.js'

const ROOT = path.join(import.meta.dirname, '..')

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

const WRITERS: Record<string, string> = {
  [LEDGER_FILE]: read('src/commands/cost/ledger.ts'),
  [STEP_CACHE_FILE]: read('src/commands/cost/step-cache.ts'),
  '.construct/implement-agreed.txt': read('templates/ai/claude/_claude/skills/implement/SKILL.md'),
  '.construct/implement-args.json': read('templates/ai/claude/_claude/skills/implement/SKILL.md'),
  [OWNED_ATLAS_PAGE]: read('src/atlas/index.ts'),
}

describe('the closed list of runtime files is what the ladder writes under .construct/', () => {
  it('names a writer for every file on the list, and a list member for every writer', () => {
    expect([...ATTACH_RUNTIME_FILES].sort()).toEqual(Object.keys(WRITERS).sort())
    for (const [name, writer] of Object.entries(WRITERS))
      expect(writer, name).toContain(name)
  })

  it('keeps the run directory pattern, the browser directory and the png suffix the browser witness writes', () => {
    const writer = read('scripts/construct/browser-witness.mjs')

    expect(writer).toContain(`RUN_DIRECTORY = ${ATTACH_RUNTIME_RUN_DIRECTORY}`)
    expect(writer).toContain(ATTACH_RUNTIME_BROWSER)
    expect(writer).toContain(ATTACH_RUNTIME_SHOT_SUFFIX)
  })

  it('lies under .construct/ and overlaps neither what attach writes nor its record', () => {
    for (const name of ATTACH_RUNTIME_FILES) {
      expect(name.startsWith('.construct/'), name).toBe(true)
      expect(ATTACH_WRITES, name).not.toContain(name)
      expect(name).not.toBe(ATTACH_RECORD_FILE)
    }
    expect(ATTACH_WRITES).not.toContain(ATTACH_RUNTIME_BROWSER)
  })
})
