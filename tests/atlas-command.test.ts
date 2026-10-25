import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATLAS_EXIT, AtlasRefusedUnconstructed, printAtlas, runAtlas } from '../src/atlas/index.js'
import { readRemoteBlob } from '../src/atlas/remote.js'
import { EDITOR_PRESETS, editorTemplate } from '../src/atlas/source-link.js'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { runInit } from '../src/commands/init.js'
import { FAILED_EXIT, reported } from '../src/failure.js'
import { readAtlasRecord } from '../src/manifest.js'
import { ENGRAM_HOME_DIR, engramDirectoryName } from '../src/model/discovery.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

const SHOP: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'shop', description: 'Takes and stores the orders of the shop', private: true, scripts: { quality: 'node --version' } }, null, 2)}\n`,
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

describe('construct atlas in a repository construct init made', () => {
  it('writes the engram into its construct.model.json and the page under .construct, which git ignores', async () => {
    const dir = await initRepository()
    const written = atlasOf(dir)
    expect(written).toEqual({ engram: path.join(dir, MODEL_FILE), page: path.join(dir, '.construct', 'atlas.html'), interpreted: false })
    const model = parseModel(readFileSync(written.engram, 'utf8'), MODEL_FILE)
    expect(model.mechanics?.components.some(component => component.path === 'src/app.ts')).toBe(true)
    const html = readFileSync(written.page, 'utf8')
    expect(readFileSync(path.join(path.dirname(written.page), 'atlas-docs.html'), 'utf8')).toContain('<h2>Take an order</h2>')
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
      interpreted: false,
    })
    expect(existsSync(path.join(dir, MODEL_FILE))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    const html = readFileSync(written.page, 'utf8')
    const data = pageData(html)
    expect(data.files).toEqual(['README.md', 'package.json', 'src/orders/api.ts', 'src/orders/store.ts'])
    expect(data.reasons).toEqual({ 'README.md': 'type-not-scanned', 'package.json': 'type-not-scanned' })
  })

  it('heads the page with the name and description package.json gives, not the folder name, and says where each came from', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })
    const hero = /<header class="hero">[\s\S]*?<\/header>/.exec(readFileSync(atlasOf(dir).page, 'utf8'))![0]
    expect(hero).toContain('<h1 class="repo">shop</h1>')
    expect(hero).toContain('<p class="lede">Takes and stores the orders of the shop</p>')
    expect(hero).toContain('<span>name from package.json</span><span>description from package.json</span>')
    expect(hero).not.toContain(path.basename(dir))
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
    expect(parseModel(readFileSync(engram, 'utf8'), MODEL_FILE).stages.map(stage => stage.label)).toEqual(['Take an order'])
    const data = pageData(html)
    expect(data.contours.map(contour => contour.name)).toEqual(['shop'])
    expect(data.contours[0]!.components.find(component => component.name === 'src')!.files.map(file => data.files[file])).toEqual(['src/orders/api.ts', 'src/orders/store.ts'])
    expect(git(dir, 'status', '--porcelain')).toBe('')
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
  it('atlas refuses a repository with neither an init construct.json nor an attach record', () => {
    const dir = foreignRepository()
    expect(() => atlasOf(dir)).toThrow(AtlasRefusedUnconstructed)
    expect(existsSync(path.join(home(), ENGRAM_HOME_DIR, engramDirectoryName(dir)))).toBe(false)
    expect(git(dir, 'status', '--porcelain', '--ignored')).toBe('')
  })

  it('refuses through the failure line the CLI prints, naming attach as the way in, and exits 1', () => {
    const lines: string[] = []
    const plain = createUi(resolveTheme({ plain: true }), line => lines.push(line))
    expect(reported(plain, () => atlasOf(foreignRepository()))).toBe(FAILED_EXIT)
    expect(lines.join('\n')).toContain(PLAIN_LORE.atlasRefusedUnconstructed)
    expect(PLAIN_LORE.atlasRefusedUnconstructed).toContain('construct attach')
  })
})

describe('construct atlas in a repository construct attach jacked into by this build', () => {
  it('atlas runs on a repository attached by this build', async () => {
    const dir = foreignRepository()
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', yes: true })).status).toBe('done')
    const written = atlasOf(dir)
    expect(existsSync(written.engram)).toBe(true)
    expect(existsSync(written.page)).toBe(true)
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
      const { root } = pageData(readFileSync(page, 'utf8')) as unknown as { root: string }
      expect(path.resolve(path.dirname(page), root)).toBe(dir)
    }
  })
})

describe('construct atlas over a repository whose files discovery mostly cannot read', () => {
  it('builds the Atlas with every tracked file as a node, and each file it cannot read carries relations unknown with the reason', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'construct-atlas-unknown-')), 'unknown-types')
    cpSync(path.resolve(import.meta.dirname, 'fixtures/engram/unknown-types'), dir, { recursive: true })
    commitAll(dir)
    expect((await runAttach(ui, { dir, yes: true })).status).toBe('done')
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

describe('a source link opens the editor or the remote the repository names', () => {
  const ORIGIN = 'git@github.com:acme/shop.git'

  function sourceHrefs(page: string): string[] {
    return [...markupOf(readFileSync(page, 'utf8')).matchAll(/href="([^"#][^"]*)" data-source/g)].map(match => match[1]!)
  }

  it('the remote is read from .git/config in an ordinary repository', async () => {
    const dir = await initRepository()
    git(dir, 'remote', 'add', 'origin', ORIGIN)
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    const { page } = atlasOf(dir)
    const blob = `https://github.com/acme/shop/blob/${sha}`
    expect((pageData(readFileSync(page, 'utf8')) as unknown as { source: unknown }).source).toEqual({ template: null, remote: blob })
    expect(sourceHrefs(path.join(path.dirname(page), 'atlas-docs.html'))).toEqual([`${blob}/src`])
  })

  it('the remote is read through gitdir and commondir in a worktree whose .git is a file', async () => {
    const dir = await initRepository()
    git(dir, 'remote', 'add', 'upstream', 'https://gitlab.com/acme/shop.git')
    const worktree = path.join(mkdtempSync(path.join(tmpdir(), 'construct-atlas-wt-')), 'wt')
    git(dir, 'worktree', 'add', '-q', '-b', 'side', worktree)
    expect(readFileSync(path.join(worktree, '.git'), 'utf8')).toMatch(/^gitdir: /)
    const sha = git(worktree, 'rev-parse', 'HEAD').trim()
    const { page } = runAtlas({ dir: worktree, home: home(), attached: false })
    expect(sourceHrefs(path.join(path.dirname(page), 'atlas-docs.html'))).toEqual([`https://gitlab.com/acme/shop/blob/${sha}/src`])
  })

  it('a repository with no remote gets the link of step 3 and no error', async () => {
    const dir = await initRepository()
    const { page } = atlasOf(dir)
    expect((pageData(readFileSync(page, 'utf8')) as unknown as { source: unknown }).source).toEqual({ template: null, remote: null })
    expect(sourceHrefs(path.join(path.dirname(page), 'atlas-docs.html'))).toEqual(['../src'])
  })

  it('reads the editor template from construct.json through the manifest loader', async () => {
    const dir = await initRepository()
    const manifest = JSON.parse(readFileSync(path.join(dir, 'construct.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(path.join(dir, 'construct.json'), `${JSON.stringify({ ...manifest, atlas: { open: 'zed' } }, null, 2)}\n`)
    const html = readFileSync(atlasOf(dir).page, 'utf8')
    expect((pageData(html) as unknown as { source: unknown }).source).toEqual({ template: 'zed://file/{abs}:{line}', remote: null })
    expect(html).not.toContain(dir)
  })
})

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

interface GitFixture {
  config: string
  head?: string
  refs?: Record<string, string>
  packed?: string
}

function gitTree(fixture: GitFixture): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-atlas-remote-'))
  const dotGit = path.join(root, '.git')
  mkdirSync(dotGit)
  writeFileSync(path.join(dotGit, 'config'), fixture.config)
  writeFileSync(path.join(dotGit, 'HEAD'), `${fixture.head ?? 'ref: refs/heads/main'}\n`)
  for (const [ref, sha] of Object.entries(fixture.refs ?? { 'refs/heads/main': SHA })) {
    mkdirSync(path.dirname(path.join(dotGit, ref)), { recursive: true })
    writeFileSync(path.join(dotGit, ref), `${sha}\n`)
  }
  if (fixture.packed != null)
    writeFileSync(path.join(dotGit, 'packed-refs'), fixture.packed)
  return root
}

function remote(name: string, url: string): string {
  return `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`
}

const REMOTE_CASES: { name: string, fixture: GitFixture, blob: string | null }[] = [
  { name: 'an scp-style GitHub url with a .git suffix', fixture: { config: remote('origin', 'git@github.com:acme/shop.git') }, blob: `https://github.com/acme/shop/blob/${SHA}` },
  { name: 'an https url whose user and token never reach the link', fixture: { config: remote('origin', 'https://bot:ghp_SECRET@github.com/acme/shop.git') }, blob: `https://github.com/acme/shop/blob/${SHA}` },
  { name: 'an ssh url with a user and a port', fixture: { config: remote('origin', 'ssh://git@gitlab.com:22/acme/group/shop.git') }, blob: `https://gitlab.com/acme/group/shop/blob/${SHA}` },
  { name: 'a trailing slash and no .git suffix', fixture: { config: remote('origin', 'https://github.com/acme/shop/') }, blob: `https://github.com/acme/shop/blob/${SHA}` },
  { name: 'origin chosen over a remote declared before it', fixture: { config: remote('fork', 'git@github.com:someone/shop.git') + remote('origin', 'git@github.com:acme/shop.git') }, blob: `https://github.com/acme/shop/blob/${SHA}` },
  { name: 'the first remote when there is no origin', fixture: { config: remote('upstream', 'git@gitlab.com:acme/shop.git') }, blob: `https://gitlab.com/acme/shop/blob/${SHA}` },
  { name: 'an uppercase host, linked in lowercase', fixture: { config: remote('origin', 'git@GitHub.com:acme/shop.git') }, blob: `https://github.com/acme/shop/blob/${SHA}` },
  { name: 'a host that is neither GitHub nor GitLab', fixture: { config: remote('origin', 'git@git.example.com:acme/shop.git') }, blob: null },
  { name: 'a remote with no url', fixture: { config: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' }, blob: null },
  { name: 'a config with no remote', fixture: { config: '[core]\n\tbare = false\n' }, blob: null },
  { name: 'a detached HEAD', fixture: { config: remote('origin', 'git@github.com:acme/shop.git'), head: OTHER_SHA, refs: {} }, blob: `https://github.com/acme/shop/blob/${OTHER_SHA}` },
  { name: 'a ref held only in packed-refs', fixture: { config: remote('origin', 'git@github.com:acme/shop.git'), refs: {}, packed: `# pack-refs with: peeled fully-peeled sorted\n${OTHER_SHA} refs/heads/main\n` }, blob: `https://github.com/acme/shop/blob/${OTHER_SHA}` },
  { name: 'a branch with no commit yet', fixture: { config: remote('origin', 'git@github.com:acme/shop.git'), refs: {} }, blob: null },
]

describe('the remote blob read from git files', () => {
  for (const { name, fixture, blob } of REMOTE_CASES) {
    it(`gives ${blob == null ? 'no link' : 'the blob link'} for ${name}`, () => {
      const read = readRemoteBlob(gitTree(fixture))
      expect(read).toBe(blob)
      expect(read ?? '').not.toMatch(/SECRET|bot|@/)
    })
  }

  it('gives no link where there is no .git at all', () => {
    expect(readRemoteBlob(mkdtempSync(path.join(tmpdir(), 'construct-atlas-nogit-')))).toBeNull()
  })
})

const ATLAS_RECORDS: { name: string, atlas: unknown, read: { open: string } | undefined }[] = [
  { name: 'no atlas key', atlas: undefined, read: undefined },
  { name: 'a preset name', atlas: { open: 'vscode' }, read: { open: 'vscode' } },
  { name: 'a template', atlas: { open: 'vscode://file/{abs}:{line}' }, read: { open: 'vscode://file/{abs}:{line}' } },
  { name: 'an empty open', atlas: { open: '' }, read: undefined },
  { name: 'a non-string open', atlas: { open: 7 }, read: undefined },
  { name: 'a null atlas', atlas: null, read: undefined },
  { name: 'a string atlas', atlas: 'vscode', read: undefined },
]

describe('the atlas record read through the manifest loader', () => {
  for (const { name, atlas, read } of ATLAS_RECORDS) {
    it(`reads ${read == null ? 'nothing' : read.open} from construct.json with ${name}`, () => {
      const root = mkdtempSync(path.join(tmpdir(), 'construct-atlas-record-'))
      const manifest = { manifestVersion: 6, construct: '0.0.0', vars: {}, files: {}, ...(atlas === undefined ? {} : { atlas }) }
      writeFileSync(path.join(root, 'construct.json'), JSON.stringify(manifest))
      expect(readAtlasRecord(root)).toEqual(read)
    })
  }

  it('reads nothing where there is no construct.json', () => {
    expect(readAtlasRecord(mkdtempSync(path.join(tmpdir(), 'construct-atlas-record-')))).toBeUndefined()
  })
})

const TEMPLATES: { open: string | undefined, template: string | null }[] = [
  { open: 'vscode', template: 'vscode://file/{abs}:{line}' },
  { open: 'cursor', template: 'cursor://file/{abs}:{line}' },
  { open: 'zed', template: 'zed://file/{abs}:{line}' },
  { open: 'idea', template: 'idea://open?file=/{abs}&line={line}' },
  { open: 'subl://open?url=file:///{abs}&line={line}', template: 'subl://open?url=file:///{abs}&line={line}' },
  { open: 'javascript:alert({abs})', template: null },
  { open: 'data:text/html,{abs}', template: null },
  { open: 'JavaScript:alert({abs})', template: null },
  { open: 'DATA:text/html,{abs}', template: null },
  { open: 'vbscript:{abs}', template: null },
  { open: 'blob:{abs}', template: null },
  { open: 'vscode://file/README.md', template: null },
  { open: '{abs}:{line}', template: null },
  { open: 'notepad', template: null },
  { open: undefined, template: null },
]

describe('the editor template a construct.json open names', () => {
  for (const { open, template } of TEMPLATES) {
    it(`${String(open)} gives ${template ?? 'no template'}`, () => {
      expect(editorTemplate(open)).toBe(template)
    })
  }

  it('names a template for every preset', () => {
    expect(Object.keys(EDITOR_PRESETS).sort()).toEqual(['cursor', 'idea', 'vscode', 'zed'])
  })
})

describe('printAtlas', () => {
  it('names the page it wrote and exits 0', () => {
    const lines: string[] = []
    const plain = createUi(resolveTheme({ plain: true }), line => lines.push(line.trimEnd()))
    expect(printAtlas(plain, { engram: '/e/construct.model.json', page: '/p/atlas.html', interpreted: true })).toBe(ATLAS_EXIT.written)
    expect(lines).toEqual([PLAIN_LORE.atlasPageWritten('/p/atlas.html')])
  })

  it('an atlas with nothing interpreted names /construct-atlas and /construct-discover first', async () => {
    const dir = await initRepository()
    const lines: string[] = []
    const plain = createUi(resolveTheme({ plain: true }), line => lines.push(line.trimEnd()))
    const written = atlasOf(dir)
    expect(written.interpreted).toBe(false)
    expect(printAtlas(plain, written)).toBe(ATLAS_EXIT.written)
    expect(lines[0]).toContain('/construct-atlas')
    expect(lines[0]).toContain('/construct-discover')
    expect(lines[1]).toBe(PLAIN_LORE.atlasPageWritten(written.page))
  })

  it('an atlas with an interpreted part prints only the page it wrote', async () => {
    const dir = await initRepository()
    const model = JSON.parse(readFileSync(path.join(dir, MODEL_FILE), 'utf8')) as Record<string, unknown>
    const interpretation = { authoredBy: 'discovery', components: [{ id: 'orders', contour: 'core', name: 'Orders', purpose: 'Takes the orders', files: ['src'] }] }
    writeFileSync(path.join(dir, MODEL_FILE), `${JSON.stringify({ ...model, interpretation }, null, 2)}\n`)
    const lines: string[] = []
    const plain = createUi(resolveTheme({ plain: true }), line => lines.push(line.trimEnd()))
    const written = atlasOf(dir)
    expect(written.interpreted).toBe(true)
    printAtlas(plain, written)
    expect(lines).toEqual([PLAIN_LORE.atlasPageWritten(written.page)])
  })
})
