import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { factoryAssets } from '../../../tsup.config.js'
import { busDownOf, renderBusDown } from '../../cli/board-page.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PAGE_SOURCE = 'scripts/cli/board-page.ts'
const STYLE_FILE = 'scripts/cli/board-page/style.css'
const SCRIPT_FILE = 'scripts/cli/board-page/script.js'
const NOW = new Date('2026-11-09T12:00:00.000Z')

function text(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8')
}

function stoppedPage(): string {
  return renderBusDown(busDownOf(NOW, 'database is locked', path.join(ROOT, 'no-such-board-data.js'), { file: 'no-handoff.md', text: null }))
}

describe('the page reads its style and script from static files', () => {
  it('the rendered page carries the style file as its style', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(stoppedPage())![1]!
    expect(style.trim()).toBe(text(STYLE_FILE).trim())
    expect(text(STYLE_FILE)).toContain('@keyframes --animation-blink')
  })

  it('the page source holds neither the style nor the script text', () => {
    const source = text(PAGE_SOURCE)
    expect(source).not.toContain('@keyframes')
    expect(source).not.toContain('localStorage')
    expect(text(SCRIPT_FILE)).toContain('localStorage.setItem(names.viewKey')
  })

  it('both static files ship with the factory build', () => {
    expect(factoryAssets()).toEqual(expect.arrayContaining([STYLE_FILE, SCRIPT_FILE]))
  })
})
