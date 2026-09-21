import { readFileSync, writeFileSync } from 'node:fs'
import { CHANGELOG_PATH, handWrittenNotes, INDEX_PATH, parseChangelog } from './changelog.js'
import { renderIndex } from './render.js'

const entries = parseChangelog(readFileSync(CHANGELOG_PATH, 'utf8'))
writeFileSync(INDEX_PATH, renderIndex(entries, handWrittenNotes()))
console.warn(`[release-notes] ${entries.length} versions → docs/release-notes/index.md`)
