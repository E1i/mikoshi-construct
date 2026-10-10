import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATLAS_EXIT, printAtlas, runAtlas } from '../src/atlas/index.js'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { runInit } from '../src/commands/init.js'
import { ENGRAM_HOME_DIR, engramDirectoryName } from '../src/model/discovery.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

const SHOP: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'shop', private: true, scripts: { quality: 'node --version' } }, null, 2)}\n`,
  'src/orders/api.ts': 'import { save } from \'./store.js\'\n\nexport function place(): void {\n  save()\n}\n',
  'src/orders/store.ts': 'export function save(): void {}\n',
  'README.md': '# shop\n',
}

const STAGED_NODES = {
  stages: [{ id: 'take', label: 'Take an order' }],
  nodes: [{ id: 'orders', label: 'Orders', stage: 'take', source: { path: 'src/orders' }, supportedBy: [] }],
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function commitAll(dir: string): void {
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
}

function foreignRepository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-atlas-'))
  for (const [file, content] of Object.entries(SHOP)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  commitAll(dir)
  return dir
}

async function initRepository(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-atlas-init-'))
  await runInit(ui, { dir, yes: true, dryRun: false, preset: 'node-backend', ai: 'claude' })
  const model = JSON.parse(readFileSync(path.join(dir, MODEL_FILE), 'utf8')) as Record<string, unknown>
  writeFileSync(path.join(dir, MODEL_FILE), `${JSON.stringify({ ...model, ...STAGED_NODES, nodes: [{ ...STAGED_NODES.nodes[0], source: { path: 'src' } }] }, null, 2)}\n`)
  commitAll(dir)
  return dir
}

function atlasOf(dir: string, out?: string): ReturnType<typeof runAtlas> {
  return runAtlas({ dir, home: home(), attached: readAttachRecord(dir) != null, out })
}

interface PageData {
  files: string[]
  states: string[]
  reasons: Record<string, string>
  contours: { id: string, name: string, components: { name: string, files: number[] }[] }[]
  relations: [number, number, number, number][]
}

function pageData(html: string): PageData {
  return JSON.parse(/const DATA = (.*);\n/.exec(html)![1]!) as PageData
}

function markupOf(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/g, '')
}

function sourceTargets(page: string): string[] {
  const html = markupOf(readFileSync(page, 'utf8'))
  return [...html.matchAll(/href="([^"#][^"]*)" data-source/g)].map(match => path.resolve(path.dirname(page), decodeURIComponent(match[1]!)))
}

describe('construct atlas in a repository construct init made', () => {
  it('writes the engram into its construct.model.json and the page under .construct, which git ignores', async () => {
    const dir = await initRepository()
    const written = atlasOf(dir)
    expect(written).toEqual({ engram: path.join(dir, MODEL_FILE), page: path.join(dir, '.construct', 'atlas.html') })
    const model = parseModel(readFileSync(written.engram, 'utf8'), MODEL_FILE)
    expect(model.mechanics?.components.some(component => component.path === 'src/app.ts')).toBe(true)
    const html = readFileSync(written.page, 'utf8')
    expect(html).toContain('<h2>Take an order</h2>')
    expect(pageData(html).files).toContain('src/app.ts')
    expect(git(dir, 'status', '--porcelain')).toBe(` M ${MODEL_FILE}\n`)
  })

  it('writes no docs view when the caller says the repository is attached, init or not', async () => {
    const dir = await initRepository()
    const written = runAtlas({ dir, home: home(), attached: true })
    expect(existsSync(path.join(path.dirname(written.page), 'atlas-docs.html'))).toBe(false)
    expect(readFileSync(written.page, 'utf8')).not.toContain('class="switch"')
  })

  it('writes the docs view beside the map, each with the switch to the other', async () => {
    const dir = await initRepository()
    const { page } = atlasOf(dir)
    const docs = path.join(path.dirname(page), 'atlas-docs.html')
    expect(readFileSync(docs, 'utf8')).toContain('<h2>Take an order</h2>')
    expect(readFileSync(docs, 'utf8')).toContain('<a href="atlas.html">Map</a>')
    expect(readFileSync(page, 'utf8')).toContain('<a href="atlas-docs.html">Docs</a>')
  })

  it('names the docs view after a map written with --out, and its Map link goes back to that map', async () => {
    const dir = await initRepository()
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'atlas-out-')), 'view.html')
    runAtlas({ dir, home: home(), attached: false, out })
    const docs = readFileSync(path.join(path.dirname(out), 'view-docs.html'), 'utf8')
    expect(docs).toContain('<a href="view.html">Map</a>')
    expect(readFileSync(out, 'utf8')).toContain('<a href="view-docs.html">Docs</a>')
  })

  it('never lets the docs view overwrite a map written with --out under the docs view\'s default name', async () => {
    const dir = await initRepository()
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'atlas-out-')), 'atlas-docs.html')
    runAtlas({ dir, home: home(), attached: false, out })
    expect(readFileSync(out, 'utf8')).toContain('<a href="atlas-docs-docs.html">Docs</a>')
    expect(readFileSync(path.join(path.dirname(out), 'atlas-docs-docs.html'), 'utf8')).toContain('<a href="atlas-docs.html">Map</a>')
  })

  it('a second run writes the same engram and the same page, byte for byte', async () => {
    const dir = await initRepository()
    const first = atlasOf(dir)
    const before = [readFileSync(first.engram), readFileSync(first.page)]
    const second = atlasOf(dir)
    expect(second).toEqual(first)
    expect(readFileSync(second.engram).equals(before[0]!)).toBe(true)
    expect(readFileSync(second.page).equals(before[1]!)).toBe(true)
  })
})

describe('construct atlas in a repository construct attach jacked into, with no init', () => {
  it('writes the engram under the home directory, the page into the .construct directory attach excludes, and nothing git sees', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    expect(git(dir, 'status', '--porcelain')).toBe('')
    const written = atlasOf(dir)
    expect(written).toEqual({
      engram: path.join(home(), ENGRAM_HOME_DIR, engramDirectoryName(dir), MODEL_FILE),
      page: path.join(dir, '.construct', 'atlas.html'),
    })
    expect(existsSync(path.join(dir, MODEL_FILE))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    const html = readFileSync(written.page, 'utf8')
    const data = pageData(html)
    expect(data.files).toEqual(['README.md', 'package.json', 'src/orders/api.ts', 'src/orders/store.ts'])
    expect(data.reasons).toEqual({ 'README.md': 'type-not-scanned', 'package.json': 'type-not-scanned' })
  })

  it('writes no documentation view into an attached repository and draws no switch on its map', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    const written = atlasOf(dir)
    expect(existsSync(path.join(dir, '.construct', 'atlas-docs.html'))).toBe(false)
    expect(existsSync(path.join(path.dirname(written.engram), 'atlas-docs.html'))).toBe(false)
    expect(readFileSync(written.page, 'utf8')).not.toContain('class="switch"')
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('a second run writes the same engram and the same page, byte for byte', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    const first = atlasOf(dir)
    const before = [readFileSync(first.engram), readFileSync(first.page)]
    atlasOf(dir)
    expect(readFileSync(first.engram).equals(before[0]!)).toBe(true)
    expect(readFileSync(first.page).equals(before[1]!)).toBe(true)
  })

  it('keeps the parts the engram already names and maps their code under the contour the package declares', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    const engram = atlasOf(dir).engram
    const model = JSON.parse(readFileSync(engram, 'utf8')) as Record<string, unknown>
    writeFileSync(engram, `${JSON.stringify({ ...model, ...STAGED_NODES }, null, 2)}\n`)
    const html = readFileSync(atlasOf(dir).page, 'utf8')
    expect(html).toContain('<h2>Take an order</h2>')
    const data = pageData(html)
    expect(data.contours.map(contour => contour.name)).toEqual(['shop'])
    expect(data.contours[0]!.components.find(component => component.name === 'src')!.files.map(file => data.files[file])).toEqual(['src/orders/api.ts', 'src/orders/store.ts'])
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })
})

describe('construct atlas in a repository with neither init nor attach, docs view', () => {
  it('writes no documentation view anywhere', () => {
    const dir = foreignRepository()
    const written = atlasOf(dir)
    expect(existsSync(path.join(path.dirname(written.page), 'atlas-docs.html'))).toBe(false)
    expect(readFileSync(written.page, 'utf8')).not.toContain('class="switch"')
    expect(git(dir, 'status', '--porcelain', '--ignored')).toBe('')
  })
})

describe('construct detach after construct atlas', () => {
  it('takes the atlas page with the rest of what attach owned, so git sees no .construct/ afterwards', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    expect(existsSync(atlasOf(dir).page)).toBe(true)
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(git(dir, 'status', '--porcelain', '--ignored')).not.toContain('.construct/')
  })
})

describe('construct atlas in a repository with neither init nor attach', () => {
  it('writes the engram and the page under the home directory and nothing into the repository', () => {
    const dir = foreignRepository()
    const written = atlasOf(dir)
    const engramDir = path.join(home(), ENGRAM_HOME_DIR, engramDirectoryName(dir))
    expect(written).toEqual({ engram: path.join(engramDir, MODEL_FILE), page: path.join(engramDir, 'atlas.html') })
    expect(git(dir, 'status', '--porcelain', '--ignored')).toBe('')
  })
})

describe('open the source resolves from where the page lies', () => {
  it('resolves every source link to the repository path, for the default page and for --out', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    const engram = atlasOf(dir).engram
    const model = JSON.parse(readFileSync(engram, 'utf8')) as Record<string, unknown>
    writeFileSync(engram, `${JSON.stringify({ ...model, ...STAGED_NODES }, null, 2)}\n`)
    const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), 'construct-atlas-out-')), 'deep', 'map.html')
    for (const page of [atlasOf(dir).page, atlasOf(dir, elsewhere).page]) {
      const targets = sourceTargets(page)
      expect(targets).toEqual([path.join(dir, 'src/orders')])
      expect(existsSync(targets[0]!)).toBe(true)
    }
  })
})

describe('construct atlas over a repository whose files discovery mostly cannot read', () => {
  it('builds the Atlas with every tracked file as a node, and each file it cannot read carries relations unknown with the reason', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'construct-atlas-unknown-')), 'unknown-types')
    cpSync(path.resolve(import.meta.dirname, 'fixtures/engram/unknown-types'), dir, { recursive: true })
    commitAll(dir)
    const written = atlasOf(dir)
    const tracked = git(dir, 'ls-files').split('\n').filter(file => file !== '')
    const html = readFileSync(written.page, 'utf8')
    const data = pageData(html)
    expect(data.files).toEqual([...tracked].sort())
    expect(data.reasons).toEqual(Object.fromEntries(['README.md', 'assets/hall.blend', 'notes.xyz', 'src/shader.glsl'].map(file => [file, 'type-not-scanned'])))
    expect(data.states[data.files.indexOf('src/main.ts')]).toBe('held')
    expect(data.relations.map(([from, to, line]) => `${data.files[from]}:${line} → ${data.files[to]}`)).toContain('src/main.ts:1 → src/shader.glsl')
  })
})

describe('printAtlas', () => {
  it('names the page it wrote and exits 0', () => {
    const lines: string[] = []
    const plain = createUi(resolveTheme({ plain: true }), line => lines.push(line))
    expect(printAtlas(plain, { engram: '/e/construct.model.json', page: '/p/atlas.html' })).toBe(ATLAS_EXIT.written)
    expect(lines.join('\n')).toContain('/p/atlas.html')
  })
})
