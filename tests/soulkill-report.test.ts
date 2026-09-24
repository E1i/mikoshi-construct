import type { DetectReport } from '../src/detect/index.js'
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

function report(overrides: Partial<DetectReport> = {}): string {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  printDetectReport(createUi(resolveTheme({ plain: true }), write), { ...detect(mkdtempSync(path.join(tmpdir(), 'construct-soulkill-'))), ...overrides })
  return text
}

function row(text: string, label: string): string {
  return text.split('\n').find(line => line.includes(`${label}:`) || line.includes(`${label} `)) ?? ''
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

describe('the detected facts name the pnpm on the CLI\'s PATH as the CLI\'s, not as the repository\'s', () => {
  it('puts the host pnpm version on its own CLI line that says it was not read from the repository', () => {
    const text = report({ packageManager: 'npm', pnpmVersion: '9.9.9' })
    expect(row(text, 'CLI pnpm')).toContain('pnpm 9.9.9')
    expect(row(text, 'CLI pnpm')).toContain('not read from this repository')
    expect(row(text, 'Package manager')).not.toContain('9.9.9')
  })

  it('leaves the CLI pnpm line out when no pnpm is on the PATH', () => {
    const text = report({ pnpmVersion: null })
    expect(row(text, 'CLI pnpm')).toBe('')
  })
})
