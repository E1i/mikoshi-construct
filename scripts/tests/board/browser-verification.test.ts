import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBoard } from '../../board/run.js'
import { callsBrowserWitness, VERIFICATION_WORDS } from '../../board/verification.js'

const BASIC = path.join(import.meta.dirname, 'fixtures/basic')
const NOW = new Date('2026-09-28T12:00Z')

const CALLED = 'Acceptance: no horizontal scroll at 375 — witness: `node scripts/construct/browser-witness.mjs --serve \'pnpm dev --port {port}\' --page / --at 375 --no-hscroll`; the build is green — witness: `pnpm build`'
const DESIGN_ONLY = 'Design:\n- the carrier scripts/construct/browser-witness.mjs is untouched\n\nAcceptance: the build is green — witness: `pnpm build`'
const OTHER_WITNESS = 'Acceptance: the page renders — witness: `pnpm exec playwright test`'

function boardText(briefs: Record<string, string>, id: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'board-browser-'))
  cpSync(BASIC, dir, { recursive: true })
  for (const [name, text] of Object.entries(briefs))
    writeFileSync(path.join(dir, name), text)
  const gh = (args: string[]): string => (args[1] === 'list' ? '[]' : JSON.stringify({ statusCheckRollup: [] }))
  return runBoard(['--dir', dir, id], { gh, now: NOW, defaultDir: dir, colour: false }).stdout
}

describe('the browser verification class is derived from the witnesses of a ladder brief', () => {
  it('knows browser as a verification word', () => {
    expect(VERIFICATION_WORDS).toContain('browser')
  })

  it.each([
    [CALLED, true],
    [DESIGN_ONLY, false],
    [OTHER_WITNESS, false],
    ['', false],
  ])('callsBrowserWitness(%j) is %s', (text, expected) => {
    expect(callsBrowserWitness(text)).toBe(expected)
  })

  it('shows verification browser on a ladder attempt whose brief witness calls the carrier', () => {
    expect(boardText({ 'brief-alpha.md': CALLED }, '101')).toContain('    verification browser (a brief witness calls browser-witness.mjs)')
  })

  it('shows no verification on a ladder attempt that mentions the carrier outside a witness', () => {
    expect(boardText({ 'brief-alpha.md': DESIGN_ONLY }, '101').filter(line => line.includes('verification'))).toEqual([])
  })
})
