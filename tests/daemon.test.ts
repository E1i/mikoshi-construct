import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { readDaemonObjects } from '../src/commands/cost/claude-code.js'
import { costJson, labelledAgentTokens } from '../src/commands/cost/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface Evidence {
  object: string
  verdict: string
  line: string
  lab: string[]
  screenshot: string | null
  console: string | null
  agent: string | null
}

interface DaemonResult {
  status: string
  run: string
  objects: Evidence[]
  unobserved: string[]
}

interface AgentOptions {
  label?: string
  schema?: unknown
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/daemon.workflow'
const CORE = ['scripts/construct/daemon-run.mjs', 'scripts/construct/daemon.mjs', 'scripts/construct/daemon-adapter.schema.json']
const TWINS = ['scripts/construct/daemon-run.mjs', 'scripts/construct/daemon.workflow']
const ADAPTER = '.construct/daemon/sample'
const RUN = '20261028T101010123Z-4242'
const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<DaemonResult>
const ui = createUi(resolveTheme({ plain: true }), silentWriter)

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

function repository(objects: string[]): string {
  const root = scratch('construct-daemon-')
  for (const file of CORE)
    cpSync(path.join(REPO_ROOT, file), path.join(root, file))
  write(root, 'extension/manifest.json', '{"manifest_version":3,"name":"sample","version":"1.0.0"}\n')
  write(root, `${ADAPTER}/mechanic.md`, 'Open the page and save what you saw.\n')
  write(root, `${ADAPTER}/objects.mjs`, `for (const id of ${JSON.stringify(objects)}) console.log(JSON.stringify({ id }))\n`)
  write(root, `${ADAPTER}/prepare.mjs`, [
    'import { writeFileSync } from \'node:fs\'',
    'const [copy, id] = process.argv.slice(2)',
    'if (id.startsWith(\'broken\')) { console.error(\'no data for \' + id); process.exit(1) }',
    'writeFileSync(copy + \'/object.json\', JSON.stringify({ id }))',
    'console.log(\'prepared \' + id)',
    '',
  ].join('\n'))
  write(root, `${ADAPTER}/success.mjs`, [
    'import { existsSync } from \'node:fs\'',
    'const [evidence] = process.argv.slice(2)',
    'if (!existsSync(evidence + \'/lab-1.json\')) { console.log(\'no lab output in \' + evidence); process.exit(1) }',
    'console.log(\'the badge was seen\')',
    '',
  ].join('\n'))
  write(root, `${ADAPTER}/adapter.json`, JSON.stringify({
    extension: { directory: 'extension' },
    prepare: `node ${ADAPTER}/prepare.mjs`,
    objects: `node ${ADAPTER}/objects.mjs`,
    mechanic: `${ADAPTER}/mechanic.md`,
    success: `node ${ADAPTER}/success.mjs`,
  }))
  return root
}

function commandOf(prompt: string): string {
  const command = prompt.split('\n').find(line => line.startsWith('node scripts/construct/daemon-run.mjs '))
  if (command == null)
    throw new Error(`no command in the prompt: ${prompt}`)
  return command
}

function run(root: string, command: string): CommandResult {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8' })
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

function evidenceDirectoryOf(prompt: string): string {
  const match = prompt.match(/into (\S+)\/ and nowhere else/)
  if (match?.[1] == null)
    throw new Error(`no evidence directory in the prompt: ${prompt}`)
  return match[1]
}

async function runDaemon(root: string, objects: number, limit?: number): Promise<{ result: DaemonResult, mechanics: string[], widest: number }> {
  const mechanics: string[] = []
  let active = 0
  let widest = 0
  async function agent(prompt: string, options: AgentOptions = {}): Promise<unknown> {
    if (options.schema != null)
      return run(root, commandOf(prompt))
    mechanics.push(options.label ?? '')
    active += 1
    widest = Math.max(widest, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    const evidence = evidenceDirectoryOf(prompt)
    write(root, `${evidence}/lab-1.json`, '{"observed":true}\n')
    write(root, `${evidence}/shot.png`, 'png')
    write(root, `${evidence}/console.json`, '[]\n')
    active -= 1
    return 'observed'
  }
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  const args = { adapter: ADAPTER, run: RUN, ...(limit == null ? {} : { limit }) }
  const result = await new AsyncFunction('args', 'agent', 'log', 'phase', source)(args, agent, () => {}, () => {})
  expect(result.objects).toHaveLength(objects)
  return { result, mechanics, widest }
}

function evidenceOf(root: string, object: string): Evidence {
  return JSON.parse(readFileSync(path.join(root, '.construct/daemon', RUN, object, 'evidence.json'), 'utf8')) as Evidence
}

describe('daemon.workflow and daemon-run.mjs', () => {
  it('builds an object\'s evidence.json from the success command\'s exit and line and the lab output paths', async () => {
    const root = repository(['alpha'])

    const { result } = await runDaemon(root, 1)

    const directory = `.construct/daemon/${RUN}/alpha`
    const expected = {
      object: 'alpha',
      verdict: 'holds',
      line: 'the badge was seen',
      lab: [`${directory}/lab-1.json`],
      screenshot: `${directory}/shot.png`,
      console: `${directory}/console.json`,
      agent: `daemon:${RUN}:alpha`,
    }
    expect(evidenceOf(root, 'alpha')).toEqual(expected)
    expect(result.objects).toEqual([expected])
  })

  it('records an object whose prepare fails as unobserved and starts no agent for it', async () => {
    const root = repository(['alpha', 'broken'])

    const { result, mechanics } = await runDaemon(root, 2)

    expect(mechanics).toEqual([`daemon:${RUN}:alpha`])
    expect(evidenceOf(root, 'broken')).toEqual({ object: 'broken', verdict: 'unobserved', line: 'prepare exited 1: no data for broken', lab: [], screenshot: null, console: null, agent: null })
    expect(result.unobserved).toEqual(['broken'])
  })

  it('runs no more than the limit of objects at once', async () => {
    const root = repository(['a', 'b', 'c', 'd', 'e'])

    const { mechanics, widest } = await runDaemon(root, 5, 2)

    expect(mechanics).toHaveLength(5)
    expect(widest).toBe(2)
  })

  it('runs two objects at once when no limit is given', async () => {
    const root = repository(['a', 'b', 'c'])

    expect((await runDaemon(root, 3)).widest).toBe(2)
  })

  it('keeps the carried twins identical to the sources', () => {
    for (const file of TWINS)
      expect(readFileSync(path.join(REPO_ROOT, 'templates/ai/claude', file), 'utf8')).toBe(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
  })
})

describe('the cost of a daemon object', () => {
  it('is the token sum of its agent\'s transcript', () => {
    const projects = scratch('construct-daemon-projects-')
    const label = `daemon:${RUN}:alpha`
    const runDirectory = path.join(projects, '-repo', 'session-1', 'subagents', 'workflows', 'wf-1')
    const assistant = (requestId: string, input: number, output: number): string => JSON.stringify({ requestId, timestamp: '2026-10-28T10:00:00Z', message: { role: 'assistant', usage: { input_tokens: input, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: output } } })
    write(runDirectory, 'agent-a1.jsonl', [assistant('r1', 100, 10), assistant('r1', 100, 10), assistant('r2', 200, 20)].join('\n'))
    write(runDirectory, 'agent-a1.meta.json', JSON.stringify({ description: label }))
    write(runDirectory, 'agent-a2.jsonl', assistant('r3', 9000, 900))
    write(runDirectory, 'agent-a2.meta.json', JSON.stringify({ description: `daemon:${RUN}:beta` }))

    expect(labelledAgentTokens(label, projects)).toBe(100 + 5 + 10 + 200 + 5 + 20)
    expect(labelledAgentTokens(`daemon:${RUN}:gamma`, projects)).toBeNull()
  })
})

describe('detach and .construct/daemon', () => {
  useIsolatedHome()

  function git(dir: string, ...args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
  }

  function attachable(): string {
    const dir = scratch('construct-daemon-detach-')
    cpSync(EXISTING_MONOREPO, dir, { recursive: true })
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'base')
    return dir
  }

  function writeEvidence(dir: string): void {
    write(dir, `.construct/daemon/${RUN}/alpha/evidence.json`, '{}\n')
    write(dir, `.construct/daemon/${RUN}/alpha/shot.png`, 'png')
  }

  it('removes a .construct/daemon created after attach', async () => {
    const dir = attachable()
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    writeEvidence(dir)

    const result = runDetach(ui, { dir })

    expect(result.removed).toEqual(expect.arrayContaining([`.construct/daemon/${RUN}/alpha/evidence.json`, `.construct/daemon/${RUN}/alpha`, `.construct/daemon/${RUN}`, '.construct/daemon']))
    expect(existsSync(path.join(dir, '.construct/daemon'))).toBe(false)
  })

  it('keeps a .construct/daemon that was there before attach', async () => {
    const dir = attachable()
    write(dir, `${ADAPTER}/adapter.json`, '{}\n')
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    writeEvidence(dir)

    runDetach(ui, { dir })

    expect(existsSync(path.join(dir, `.construct/daemon/${RUN}/alpha/evidence.json`))).toBe(true)
    expect(existsSync(path.join(dir, `${ADAPTER}/adapter.json`))).toBe(true)
  })

  async function attached(): Promise<string> {
    const dir = attachable()
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    return dir
  }

  const exists = (dir: string, file: string): boolean => existsSync(path.join(dir, file))

  it('removes only the run directory and keeps an adapter written after attach', async () => {
    const dir = await attached()
    write(dir, `${ADAPTER}/adapter.json`, '{}\n')
    writeEvidence(dir)

    runDetach(ui, { dir })

    expect(exists(dir, `.construct/daemon/${RUN}`)).toBe(false)
    expect(exists(dir, `${ADAPTER}/adapter.json`)).toBe(true)
  })

  it('keeps a run directory holding a git-tracked file', async () => {
    const dir = await attached()
    writeEvidence(dir)
    git(dir, 'add', '-f', `.construct/daemon/${RUN}/alpha/evidence.json`)
    git(dir, 'commit', '-qm', 'track evidence')

    runDetach(ui, { dir })

    expect(exists(dir, `.construct/daemon/${RUN}/alpha/evidence.json`)).toBe(true)
  })

  it('keeps a run directory with a subdirectory inside an object directory', async () => {
    const dir = await attached()
    writeEvidence(dir)
    write(dir, `.construct/daemon/${RUN}/alpha/notes/keep.txt`, 'mine\n')

    runDetach(ui, { dir })

    expect(exists(dir, `.construct/daemon/${RUN}/alpha/notes/keep.txt`)).toBe(true)
  })

  it('keeps a run-id-shaped entry that is a file and removes the run directories beside it', async () => {
    const dir = await attached()
    writeEvidence(dir)
    write(dir, '.construct/daemon/20261028T101010124Z-1', 'a file\n')

    runDetach(ui, { dir })

    expect(exists(dir, '.construct/daemon/20261028T101010124Z-1')).toBe(true)
    expect(exists(dir, `.construct/daemon/${RUN}`)).toBe(false)
  })
})

describe('daemon-run.mjs refusals', () => {
  const SUCCESS_KILLED = 'process.kill(process.pid, \'SIGKILL\')\n'

  it('records an object whose success command is killed by a signal as unobserved', () => {
    const root = repository(['alpha'])
    write(root, `${ADAPTER}/success.mjs`, SUCCESS_KILLED)

    const verdict = run(root, `node scripts/construct/daemon-run.mjs verdict ${ADAPTER} ${RUN} alpha --agent daemon:${RUN}:alpha`)

    expect(verdict.exitCode).toBe(0)
    expect(evidenceOf(root, 'alpha')).toMatchObject({ verdict: 'unobserved', line: 'success ended without an exit code: SIGKILL' })
  })

  it('records an object whose prepare is killed by a signal as unobserved and names the signal', () => {
    const root = repository(['alpha'])
    write(root, `${ADAPTER}/prepare.mjs`, SUCCESS_KILLED)

    const prepared = run(root, `node scripts/construct/daemon-run.mjs prepare ${ADAPTER} ${RUN} alpha`)

    expect(prepared.exitCode).toBe(0)
    expect(evidenceOf(root, 'alpha')).toMatchObject({ verdict: 'unobserved', line: 'prepare ended without an exit code: SIGKILL: ' })
  })

  it('refuses objects whose listing command is killed by a signal and names the signal', () => {
    const root = repository(['alpha'])
    write(root, `${ADAPTER}/objects.mjs`, SUCCESS_KILLED)

    const listed = run(root, `node scripts/construct/daemon-run.mjs objects ${ADAPTER}`)

    expect(listed.exitCode).toBe(1)
    expect(listed.stderr).toContain('objects ended without an exit code: SIGKILL')
  })

  it('refuses objects --run with a value that is not a run id', () => {
    const root = repository(['alpha'])

    const listed = run(root, `node scripts/construct/daemon-run.mjs objects ${ADAPTER} --run ../escape`)

    expect(listed.exitCode).toBe(2)
    expect(listed.stderr).toContain('../escape is not a run id')
    expect(listed.stdout).toBe('')
  })
})

describe('the daemon objects in the cost report', () => {
  it('reads each object\'s agent from evidence.json and reports its transcript tokens', () => {
    const projects = scratch('construct-daemon-projects-')
    const root = scratch('construct-daemon-cost-')
    const runDirectory = path.join(projects, '-repo', 'session-1', 'subagents', 'workflows', 'wf-1')
    const label = `daemon:${RUN}:alpha`
    write(runDirectory, 'agent-a1.jsonl', JSON.stringify({ requestId: 'r1', timestamp: '2026-10-28T10:00:00Z', message: { role: 'assistant', usage: { input_tokens: 100, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 10 } } }))
    write(runDirectory, 'agent-a1.meta.json', JSON.stringify({ description: label }))
    write(root, `.construct/daemon/${RUN}/alpha/evidence.json`, JSON.stringify({ object: 'alpha', verdict: 'holds', agent: label }))
    write(root, `.construct/daemon/${RUN}/broken/evidence.json`, JSON.stringify({ object: 'broken', verdict: 'unobserved', agent: null }))
    write(root, `.construct/daemon/${RUN}/torn/evidence.json`, '{')

    const objects = readDaemonObjects(root, projects)

    expect(objects).toEqual([
      { run: RUN, object: 'alpha', verdict: 'holds', agent: label, tokens: 115 },
      { run: RUN, object: 'broken', verdict: 'unobserved', agent: null, tokens: null },
    ])
    const json = costJson({ status: 'empty', runtime: 'claude-code', version: '0', turns: { status: 'not recorded' }, daemon: objects }, false)
    expect(json.daemon).toEqual(objects)
  })
})
