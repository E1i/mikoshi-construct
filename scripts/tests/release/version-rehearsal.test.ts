import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { processGit } from '../../ports/git.js'
import { VERSION_PR_BRANCH_PREFIX } from '../../release/version-pr-guard.js'
import { PRIVACY_STEP, rehearseVersion, VERSION_STEP, VERSIONED_TREE_TESTS } from '../../release/version-rehearsal.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const MODULES = path.join(REPO_ROOT, 'node_modules')
const REHEARSAL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'release', 'version-rehearsal.ts')
const FEATURE_BRANCH = 'feat/a-change'
const REHEARSAL_TIMEOUT = 120_000
const COPIED = ['.changeset/config.json', 'scripts/release-notes', 'scripts/privacy', 'scripts/core/owner-commands.ts']
const REAL_SCRIPTS = ['version-packages', 'release-notes:render', 'privacy:check']
const DOTTED_EVENT_NAME = 'shift.run'
const CONSUMED_CHANGESET_TEST = 'tests/reads-pending-changesets.test.ts'

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function changeset(summary: string): string {
  return `---\n'mikoshi-construct': patch\n---\n\n${summary}\n`
}

function fixtureRepository(summary: string, files: Record<string, string> = {}, extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-version-rehearsal-fixture-'))
  roots.push(root)
  const scripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  const manifest = {
    name: 'mikoshi-construct',
    version: '0.1.0',
    type: 'module',
    scripts: Object.fromEntries(REAL_SCRIPTS.map(name => [name, scripts[name]])),
    ...extra,
  }
  for (const copied of COPIED)
    cpSync(path.join(REPO_ROOT, copied), path.join(root, copied), { recursive: true })
  const written: Record<string, string> = {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'CHANGELOG.md': '# mikoshi-construct\n',
    'README.md': '# fixture\n',
    'docs/release-notes/index.md': '# Release notes\n',
    'templates/README.md': 'templates\n',
    'tests/fixtures/README.md': 'fixtures\n',
    '.changeset/rehearsed-change.md': changeset(summary),
    ...files,
  }
  for (const [file, text] of Object.entries(written)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  processGit.read(root, ['init', '--quiet', '--initial-branch=main'])
  processGit.read(root, ['add', '--all'])
  processGit.read(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
  return root
}

function runRehearsal(root: string, headRef: string): { status: number | null, stdout: string, stderr: string } {
  symlinkSync(MODULES, path.join(root, 'node_modules'), 'dir')
  const ran = spawnSync(process.execPath, ['--import', 'tsx', REHEARSAL_SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_HEAD_REF: headRef },
  })
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

describe('the version rehearsal run as CI runs it', () => {
  const breaking = `The bus records \`${DOTTED_EVENT_NAME}\` when a shift starts.`

  it('on the version pull request rehearses nothing and exits 0, even when the tree would be red', { timeout: REHEARSAL_TIMEOUT }, () => {
    const headRef = `${VERSION_PR_BRANCH_PREFIX}main`
    const root = fixtureRepository(breaking)

    const ran = runRehearsal(root, headRef)

    expect(ran).toEqual({ status: 0, stdout: expect.stringContaining(`${headRef} is the version pull request`), stderr: '' })
    expect(ran.stdout).not.toContain('version rehearsal is')
  })

  it('on any other pull request a red rehearsal exits 1 and writes its verdict to stderr only', { timeout: REHEARSAL_TIMEOUT }, () => {
    const root = fixtureRepository(breaking)

    const ran = runRehearsal(root, FEATURE_BRANCH)

    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe('')
    expect(ran.stderr).toContain(`version rehearsal is red at ${PRIVACY_STEP}, docs/release-notes/index.md:`)
  })

  it('a green rehearsal exits 0 and writes its verdict to stdout only', { timeout: REHEARSAL_TIMEOUT }, () => {
    const passing = ['import { expect, it } from \'vitest\'', 'it(\'passes\', () => { expect(true).toBe(true) })', ''].join('\n')
    const root = fixtureRepository('The bus records a shift when it starts.', Object.fromEntries(VERSIONED_TREE_TESTS.map(test => [test, passing])))

    const ran = runRehearsal(root, FEATURE_BRANCH)

    expect(ran.stderr).toBe('')
    expect(ran.stdout).toContain('version rehearsal is green:')
    expect(ran.status).toBe(0)
  })
})

describe('every pull request rehearses the version step its changesets will take', () => {
  it('a changeset that breaks the versioned tree is red in the rehearsal', { timeout: REHEARSAL_TIMEOUT }, () => {
    const root = fixtureRepository(`The bus records \`${DOTTED_EVENT_NAME}\` when a shift starts.`)

    const verdict = rehearseVersion({ root, modules: MODULES, tests: [] })

    expect(verdict.passed).toBe(false)
    expect(verdict.passed ? null : { step: verdict.step, file: verdict.file }).toEqual({ step: PRIVACY_STEP, file: 'docs/release-notes/index.md' })
    expect(verdict.lines.join('\n')).toContain(`"${DOTTED_EVENT_NAME}"`)
  })

  it('a test that reads the changesets the release consumes is red in the rehearsal, named by its file', { timeout: REHEARSAL_TIMEOUT }, () => {
    const root = fixtureRepository('The bus records a shift when it starts.', {
      [CONSUMED_CHANGESET_TEST]: [
        'import { existsSync } from \'node:fs\'',
        'import { expect, it } from \'vitest\'',
        'it(\'reads a pending changeset\', () => { expect(existsSync(\'.changeset/rehearsed-change.md\')).toBe(true) })',
        '',
      ].join('\n'),
    })

    const verdict = rehearseVersion({ root, modules: MODULES, tests: [CONSUMED_CHANGESET_TEST] })

    expect(verdict.passed ? null : { step: verdict.step, file: verdict.file }).toEqual({ step: 'vitest', file: CONSUMED_CHANGESET_TEST })
  })

  it('a version step that consumes no changeset is red, not a vacuous pass', { timeout: REHEARSAL_TIMEOUT }, () => {
    const root = fixtureRepository('The bus records a shift when it starts.', {}, { private: true })

    const verdict = rehearseVersion({ root, modules: MODULES, tests: [] })

    expect(verdict.passed ? null : { step: verdict.step, file: verdict.file }).toEqual({ step: VERSION_STEP, file: '.changeset/rehearsed-change.md' })
  })

  it('a clean changeset passes the rehearsal', { timeout: REHEARSAL_TIMEOUT }, () => {
    const root = fixtureRepository('The bus records a shift when it starts.')

    const verdict = rehearseVersion({ root, modules: MODULES, tests: [] })

    expect(verdict).toEqual({ passed: true, lines: [expect.stringContaining(VERSION_STEP)] })
    expect(processGit.read(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
    expect(processGit.read(root, ['status', '--porcelain'])).toBe('')
  })

  it('rehearses every test that reads .changeset or CHANGELOG.md of this repository', () => {
    const readers = ['tests', 'scripts/tests']
      .flatMap(dir => processGit.read(REPO_ROOT, ['ls-files', '--', `${dir}/*.test.ts`]).split('\n'))
      .filter(file => file !== '' && file !== path.relative(REPO_ROOT, import.meta.filename))
      .filter(file => /CHANGELOG_PATH|'\.\.\/\.changeset'|'CHANGELOG\.md',/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))

    expect(readers.length).toBeGreaterThan(0)
    expect(VERSIONED_TREE_TESTS.filter(test => !existsSync(path.join(REPO_ROOT, test)))).toEqual([])
    expect(readers.filter(file => !(VERSIONED_TREE_TESTS as readonly string[]).includes(file))).toEqual([])
  })
})
