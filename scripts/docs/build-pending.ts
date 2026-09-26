import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { build } from 'vitepress'
import { CHANGELOG_PATH, handWrittenNotes, parseChangelog, REPO_ROOT } from '../release-notes/changelog.js'
import { parseChangeset, pendingEntry } from '../release-notes/pending.js'
import { renderIndex } from '../release-notes/render.js'

const CHANGESET_DIR = path.join(REPO_ROOT, '.changeset')
const DOCS = path.join(REPO_ROOT, 'docs')
const COPY = path.join(REPO_ROOT, '.docs-pending')
const GENERATED = ['.vitepress/cache', '.vitepress/dist'].map(part => path.join(DOCS, part))

function changesetFiles(): string[] {
  if (!existsSync(CHANGESET_DIR))
    return []
  return readdirSync(CHANGESET_DIR).filter(file => file.endsWith('.md') && file !== 'README.md').sort()
}

const files = changesetFiles()
const pending = pendingEntry(files.flatMap(file => parseChangeset(readFileSync(path.join(CHANGESET_DIR, file), 'utf8')) ?? []))
if (pending == null) {
  console.warn('[docs:pending] no pending changesets: the release index is what docs:build already built')
  process.exit(0)
}

try {
  rmSync(COPY, { recursive: true, force: true })
  cpSync(DOCS, COPY, { recursive: true, filter: source => !GENERATED.some(generated => source.startsWith(generated)) })
  const entries = [pending, ...parseChangelog(readFileSync(CHANGELOG_PATH, 'utf8'))]
  writeFileSync(path.join(COPY, 'release-notes/index.md'), renderIndex(entries, handWrittenNotes()))
  await build(COPY)
  console.warn('[docs:pending] the release index builds with the pending changesets rendered into it')
}
catch (error) {
  console.error(error)
  console.error(`[docs:pending] the docs do not build once the pending changesets are rendered into the release index. The error above points into .docs-pending/release-notes/index.md, a copy already removed; the text it quotes comes from one of: ${files.map(file => `.changeset/${file}`).join(', ')}`)
  process.exitCode = 1
}
finally {
  rmSync(COPY, { recursive: true, force: true })
}
