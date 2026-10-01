import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { blockBody, markerOpen, missingDiscovery } from '../src/commands/doctor/discovery.js'
import { discoveryProvenance } from '../src/commands/doctor/provenance.js'
import { runInit } from '../src/commands/init.js'
import { readManifest, sha256, writeManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const QUESTIONS_FILE = 'architecture/open-questions.md'
const POINTER = `[${QUESTIONS_FILE}](${QUESTIONS_FILE})`
const QUESTIONS = '- Which of the two command lists is the source is not settled.'

async function initialised(existing: Record<string, string> = {}): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-open-questions-'))
  for (const [file, content] of Object.entries(existing))
    writeFileSync(path.join(dir, file), content)
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
  return dir
}

function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

describe('open questions live in their own file, and AGENTS.md points at it', () => {
  it('materializes the marker in architecture/open-questions.md and only a pointer in a created AGENTS.md', async () => {
    const dir = await initialised()
    expect(read(dir, 'AGENTS.md')).not.toContain(markerOpen('open-questions'))
    expect(read(dir, 'AGENTS.md')).toContain(POINTER)
    expect(read(dir, QUESTIONS_FILE)).toContain(markerOpen('open-questions'))
    expect(readManifest(dir)!.discovery.markers['open-questions'].file).toBe(QUESTIONS_FILE)
    expect(missingDiscovery(dir, readManifest(dir)!)).toContain('open-questions')
  })

  it('puts only the pointer into an AGENTS.md the repository already had', async () => {
    const dir = await initialised({ 'AGENTS.md': '# Mine\n\nprose\n' })
    expect(read(dir, 'AGENTS.md')).not.toContain(markerOpen('open-questions'))
    expect(read(dir, 'AGENTS.md')).toContain(POINTER)
  })

  it('reads a block discovery filled in the new file as the construct wrote it', async () => {
    const dir = await initialised()
    const template = read(dir, QUESTIONS_FILE)
    const filled = template.replace(/(<!-- construct:discover:open-questions -->)[\s\S]*?(<!-- \/construct:discover:open-questions -->)/, `$1\n${QUESTIONS}\n$2`)
    writeFileSync(path.join(dir, QUESTIONS_FILE), filled)
    const manifest = readManifest(dir)!
    const body = blockBody(filled, 'open-questions')!
    writeManifest(dir, { ...manifest, discovery: { ...manifest.discovery, markers: { ...manifest.discovery.markers, 'open-questions': { file: QUESTIONS_FILE, authoredBy: 'construct', sha: sha256(body) } } } })

    expect(missingDiscovery(dir, readManifest(dir)!)).not.toContain('open-questions')
    expect(discoveryProvenance(dir, readManifest(dir)!).find(reading => reading.marker === 'open-questions')).toEqual({ marker: 'open-questions', file: QUESTIONS_FILE, authorship: 'construct' })
  })

  it('tells discovery to move a marker still recorded in AGENTS.md, both tags and all, and to record the new file', () => {
    const protocol = read(path.resolve(import.meta.dirname, '..'), 'templates/ai/shared/_claude/commands/construct-discover.md')
    expect(protocol).toContain(`**\`open-questions\`** (\`${QUESTIONS_FILE}\`)`)
    expect(protocol).toContain('delete the whole `open-questions` block (both tags) from `AGENTS.md`')
    expect(protocol).toContain('record the\n    new `file` in step 12')
    expect(protocol).toContain('when it read `construct`, record the sha of the moved\n    body; otherwise change only `file` and keep `authoredBy` and `sha`')
    expect(protocol).toContain('Rewrite each relative link in the body for the `architecture/` folder')
  })
})
