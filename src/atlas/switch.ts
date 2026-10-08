import { escaped } from '../model/page.js'

export const ATLAS_MAP_FILE = 'atlas.html'
export const ATLAS_DOCS_FILE = 'atlas-docs.html'

export type AtlasMode = 'map' | 'docs'

const MODE_WORDS: Record<AtlasMode, string> = { map: 'Map', docs: 'Docs' }
const MODE_FILES: Record<AtlasMode, string> = { map: ATLAS_MAP_FILE, docs: ATLAS_DOCS_FILE }

export const SWITCH_STYLE = `
nav.switch { display: flex; gap: 0.5rem; margin-block-end: 0.75rem; font-size: 0.85rem; }
nav.switch a { color: var(--runtime-report); padding: 0.15rem 0.6rem; border: 1px solid var(--line); border-radius: 1rem; text-decoration: none; }
nav.switch a[aria-current='page'] { color: var(--ink); border-color: var(--ink-dim); }
`

export function switchHtml(current: AtlasMode, files: Record<AtlasMode, string> = MODE_FILES): string {
  const modes: AtlasMode[] = ['map', 'docs']
  return `<nav class="switch">${modes.map(mode => `<a href="${escaped(files[mode])}"${mode === current ? ' aria-current="page"' : ''}>${MODE_WORDS[mode]}</a>`).join('')}</nav>`
}
