import type { Writer } from '../src/ui/console.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { printDetectReport } from '../src/commands/soulkill.js'
import { detect } from '../src/detect/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

function report(): string {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  printDetectReport(createUi(resolveTheme({ plain: true }), write), detect(mkdtempSync(path.join(tmpdir(), 'construct-soulkill-'))))
  return text
}

describe('the detected facts name the Node that runs the CLI as the CLI\'s, not as the repository\'s', () => {
  it('labels the Node major as the runtime construct runs on and says it was not read from the repository', () => {
    const text = report()
    expect(text).toContain('CLI runtime')
    expect(text).toContain(`Node.js ${process.versions.node.split('.')[0]}`)
    expect(text).toContain('not read from this repository')
    expect(text).not.toMatch(/^\s*(?:\S+\s*)?Runtime\b/m)
  })
})
