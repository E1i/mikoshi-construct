import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')

const ENTRY = read('templates/attach/entry.md')
const PROTOCOL_FILES = [
  'templates/ai/shared/_claude/commands/construct-discover.md',
  '.claude/commands/construct-discover.md',
]

const SECTION_HEADING = '## What the toolchain needs'

function toolchainSection(): string {
  const start = ENTRY.indexOf(SECTION_HEADING)
  if (start === -1)
    return ''
  const rest = ENTRY.slice(start + SECTION_HEADING.length)
  const end = rest.indexOf('\n## ')
  return end === -1 ? rest : rest.slice(0, end)
}

function sourceLists(): RegExpExecArray[] {
  return [...toolchainSection().matchAll(/^(?:Exact|Range) sources[^\n]*\n\n((?:- [^\n]*\n)+)/gm)]
}

function versionSources(): string[] {
  const lists = sourceLists()
  const bullets = lists.flatMap(match => match[1].trimEnd().split('\n'))
  return [...new Set(bullets.flatMap(bullet => [...bullet.matchAll(/`([^`]+)`/g)].map(span => span[1])))]
}

const OWNER_ACCEPTANCE_SET = [
  '.python-version',
  '.tool-versions',
  'runtime.txt',
  'actions/setup-python',
  'FROM python:',
  'Dockerfile',
  'environment.yml',
  'python=',
  'requires-python',
  '[tool.poetry.dependencies]',
  'setup.cfg',
  'python_requires',
  'setup.py',
  'Pipfile',
  '[requires]',
  'python_version',
  'tox.ini',
  'envlist',
  'uv.lock',
  'poetry.lock',
]

describe('the attach entry protocol names what the toolchain needs', () => {
  it('has the section, placed before what the repository can run', () => {
    expect(ENTRY).toContain(SECTION_HEADING)
    expect(ENTRY.indexOf(SECTION_HEADING)).toBeLessThan(ENTRY.indexOf('## What the repository can run'))
  })

  it('names every exact and range source of the Python version', () => {
    const section = toolchainSection()
    for (const source of OWNER_ACCEPTANCE_SET)
      expect(section, source).toContain(source)
  })

  it('says an exact source wins and a range gives its lower bound', () => {
    const section = toolchainSection()
    expect(section).toContain('An exact source wins')
    expect(section).toContain('name its lower bound')
  })

  it('searches Python projects below the root, not only the root', () => {
    const section = toolchainSection()
    expect(section).toContain('below the root')
    expect(section).toContain('backend/pyproject.toml')
  })

  it('adds no second mention of the attach command', () => {
    expect(ENTRY.split('npx mikoshi-construct attach').length - 1).toBe(1)
  })
})

describe.each(PROTOCOL_FILES)('%s carries the toolchain step', (file) => {
  const protocol = read(file)

  it('names every member of the attach entry list', () => {
    const sources = versionSources()
    expect(sourceLists()).toHaveLength(2)
    expect(sources.length).toBeGreaterThanOrEqual(20)
    for (const source of sources)
      expect(protocol, source).toContain(source)
  })

  it('keeps it inside the inventory step', () => {
    const inventory = protocol.split('\n2. **Inventory.**')[1]!.split('\n3. ')[0]!
    expect(inventory).toContain('python3.X')
    expect(inventory).toContain('below the root')
    expect(inventory).toContain('An exact source wins')
  })

  it('names the lock signal, the cited documentation and the architecture comparison', () => {
    expect(protocol).toContain('no wheel matching the named interpreter and this platform')
    expect(protocol).toContain('only a source distribution, builds from source')
    expect(protocol).toContain('`files` in `poetry.lock`')
    expect(protocol).toContain('`sdist` and `wheels` in `uv.lock`')
    expect(protocol).toContain('own installation documentation, cited by link, never from memory')
    expect(protocol).toContain('uname -m')
    expect(protocol).toContain('file "$(command -v pg_config)"')
  })

  it('says a requirements.txt without a lock is not determinable and gives the check with its limits', () => {
    expect(protocol).toContain('not determinable from a lock')
    expect(protocol).toContain('pip download --only-binary=:all: --python-version <X.Y> -r requirements.txt -d <tmp dir>')
    expect(protocol).toContain('stops at the first package without a wheel')
    expect(protocol).toContain('not the full set')
    expect(protocol).toContain('not one you run without a yes')
  })

  it('names the interpreter and the manager commands, and installs nothing', () => {
    for (const phrase of ['python3 --version', 'poetry env use python3.X', 'uv python install 3.X', 'pyenv install 3.X', 'python@3.X', 'Install nothing'])
      expect(protocol, phrase).toContain(phrase)
  })
})

describe('the attach entry protocol states the same toolchain facts', () => {
  it('holds the lock signal and the pip check with its limits', () => {
    const section = toolchainSection()
    expect(section).toContain('no wheel matching the named interpreter and this platform')
    expect(section).toContain('pip download --only-binary=:all: --python-version <X.Y> -r requirements.txt -d <tmp dir>')
    expect(section).toContain('stops at the first package without a wheel')
  })
})

describe('the discover command exists twice and says one thing', () => {
  it('keeps the template and the repository copy byte for byte equal', () => {
    expect(read(PROTOCOL_FILES[1])).toBe(read(PROTOCOL_FILES[0]))
  })
})
