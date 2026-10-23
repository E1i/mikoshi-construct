import path from 'node:path'
import { escaped } from '../model/page.js'

export type AtlasMode = 'map' | 'docs'

const MODE_WORDS: Record<AtlasMode, string> = { map: 'Map', docs: 'Docs' }

export const SWITCH_STYLE = `
nav.switch { display: flex; border: 1px solid var(--wire-glow); }
nav.switch a { font: 700 0.6875rem var(--f-mono); letter-spacing: 0.14em; text-transform: uppercase; text-decoration: none; color: var(--wire); padding: 0.3rem 0.875rem; }
nav.switch a:hover { background: var(--wire-soft); }
nav.switch a[aria-current='page'] { background: var(--wire); color: var(--void); }
`

export function docsFileOf(mapFile: string): string {
  return `${path.basename(mapFile, '.html')}-docs.html`
}

export function switchHtml(current: AtlasMode, files: Record<AtlasMode, string>): string {
  const modes: AtlasMode[] = ['map', 'docs']
  return `<nav class="switch" aria-label="View">${modes.map(mode => `<a href="${escaped(files[mode])}"${mode === current ? ' aria-current="page"' : ''}>${MODE_WORDS[mode]}</a>`).join('')}</nav>`
}
