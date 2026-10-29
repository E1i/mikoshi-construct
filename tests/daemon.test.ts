import type { AgentOptions, DaemonResult, Evidence } from './daemon-workflow.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { labelledAgentTokens, labelledTranscripts } from '../src/commands/cost/claude-code.js'
import { readDaemonObjects } from '../src/commands/cost/daemon.js'
import { costJson, costReport, projectKey } from '../src/commands/cost/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { commandOf, CORE, evidenceDirectoryOf, REPO_ROOT, run, runWorkflow } from './daemon-workflow.js'
import { useIsolatedHome } from './isolated-home.js'

const TWINS = ['scripts/construct/daemon-run.mjs', 'scripts/construct/daemon.workflow']
const ADAPTER = '.construct/daemon/sample'
const RUN = '20261028T101010123Z-4242'
const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
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

async function runDaemon(root: string, objects: number, limit?: number, mechanicReturns: unknown = 'observed'): Promise<{ result: DaemonResult, mechanics: string[], widest: number, labCopies: string[] }> {
  const mechanics: string[] = []
  const labCopies: string[] = []
  let active = 0
  let widest = 0
  async function agent(prompt: string, options: AgentOptions = {}): Promise<unknown> {
    if (options.schema != null) {
      const command = commandOf(prompt)
      const commandResult = run(root, command)
      if (command.includes(' prepare '))
        labCopies.push(...[JSON.parse(commandResult.stdout) as { labCopy: string | null }].flatMap(prepared => prepared.labCopy ?? []))
      return commandResult
    }
    mechanics.push(options.label ?? '')
    if (mechanicReturns == null)
      return null
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
  const args = { adapter: ADAPTER, run: RUN, ...(limit == null ? {} : { limit }) }
  const result = await runWorkflow(args, agent)
  expect(result.objects).toHaveLength(objects)
  return { result, mechanics, widest, labCopies }
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

  it('records an object whose mechanic agent returns nothing as unobserved with its agent label', async () => {
    const root = repository(['alpha'])

    const { result, labCopies } = await runDaemon(root, 1, undefined, null)

    const expected = { object: 'alpha', verdict: 'unobserved', line: 'the agent did not return', lab: [], screenshot: null, console: null, agent: `daemon:${RUN}:alpha` }
    expect(evidenceOf(root, 'alpha')).toEqual(expected)
    expect(result.unobserved).toEqual(['alpha'])
    expect(labCopies).toHaveLength(1)
    expect(existsSync(labCopies[0] as string)).toBe(false)
  })

  it('removes the lab copy once the verdict is written and when prepare fails', async () => {
    const root = repository(['alpha', 'broken'])

    const { labCopies } = await runDaemon(root, 2)

    expect(labCopies).toHaveLength(1)
    expect(existsSync(labCopies[0] as string)).toBe(false)
  })

  it('removes only a daemon-<object>-* directory directly under the temporary directory', () => {
    const root = repository(['alpha'])
    const elsewhere = scratch('construct-daemon-other-')
    const misnamed = scratch('daemon-beta-')

    run(root, `node scripts/construct/daemon-run.mjs unobserved ${ADAPTER} ${RUN} alpha --line gone --lab ${elsewhere}`)
    run(root, `node scripts/construct/daemon-run.mjs unobserved ${ADAPTER} ${RUN} alpha --line gone --lab ${misnamed}`)

    expect(existsSync(elsewhere)).toBe(true)
    expect(existsSync(misnamed)).toBe(true)
    expect(evidenceOf(root, 'alpha')).toMatchObject({ verdict: 'unobserved', line: 'gone', agent: null })
  })

  it('keeps a daemon-<object>-* directory nested below the temporary directory', () => {
    const root = repository(['alpha'])
    const nested = path.join(scratch('construct-daemon-parent-'), 'daemon-alpha-nested')
    mkdirSync(nested)

    run(root, `node scripts/construct/daemon-run.mjs unobserved ${ADAPTER} ${RUN} alpha --line gone --lab ${nested}`)

    expect(existsSync(nested)).toBe(true)
  })

  it('records an object whose success command exits 1 as false with its line', async () => {
    const root = repository(['alpha'])
    write(root, `${ADAPTER}/success.mjs`, 'console.log(\'the badge was missing\')\nprocess.exit(1)\n')

    const { result } = await runDaemon(root, 1)

    expect(evidenceOf(root, 'alpha')).toMatchObject({ verdict: 'false', line: 'the badge was missing' })
    expect(result.objects[0]).toMatchObject({ verdict: 'false' })
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
    const runDirectory = path.join(projects, projectKey('/repo'), 'session-1', 'subagents', 'workflows', 'wf-1')
    const assistant = (requestId: string, input: number, output: number): string => JSON.stringify({ requestId, timestamp: '2026-10-28T10:00:00Z', message: { role: 'assistant', usage: { input_tokens: input, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: output } } })
    write(runDirectory, 'agent-a1.jsonl', [assistant('r1', 100, 10), assistant('r1', 100, 10), assistant('r2', 200, 20)].join('\n'))
    write(runDirectory, 'agent-a1.meta.json', JSON.stringify({ description: label }))
    write(runDirectory, 'agent-a2.jsonl', assistant('r3', 9000, 900))
    write(runDirectory, 'agent-a2.meta.json', JSON.stringify({ description: `daemon:${RUN}:beta` }))

    const index = labelledTranscripts('/repo', projects)

    expect(labelledAgentTokens(index, label)).toBe(100 + 5 + 10 + 200 + 5 + 20)
    expect(labelledAgentTokens(index, `daemon:${RUN}:gamma`)).toBeNull()
    expect(labelledAgentTokens(labelledTranscripts('/other', projects), label)).toBeNull()
  })

  it('sums every transcript that carries the same label', () => {
    const projects = scratch('construct-daemon-projects-')
    const label = `daemon:${RUN}:alpha`
    const runDirectory = path.join(projects, projectKey('/repo'), 'session-1', 'subagents', 'workflows', 'wf-1')
    const assistant = (requestId: string, input: number, output: number): string => JSON.stringify({ requestId, timestamp: '2026-10-28T10:00:00Z', message: { role: 'assistant', usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } } })
    write(runDirectory, 'agent-a1.jsonl', assistant('r1', 100, 10))
    write(runDirectory, 'agent-a1.meta.json', JSON.stringify({ description: label }))
    write(runDirectory, 'agent-a2.jsonl', assistant('r2', 200, 20))
    write(runDirectory, 'agent-a2.meta.json', JSON.stringify({ description: label }))

    expect(labelledAgentTokens(labelledTranscripts('/repo', projects), label)).toBe(100 + 10 + 200 + 20)
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

  it('keeps a directory that is not a run id beside a run directory', async () => {
    const dir = await attached()
    writeEvidence(dir)
    write(dir, '.construct/daemon/notes/a/b.md', 'mine\n')

    runDetach(ui, { dir })

    expect(exists(dir, '.construct/daemon/notes/a/b.md')).toBe(true)
    expect(exists(dir, `.construct/daemon/${RUN}`)).toBe(false)
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

  function killedBySignal(root: string, command: 'prepare' | 'objects' | 'success'): void {
    write(root, `${ADAPTER}/${command}.mjs`, SUCCESS_KILLED)
    const adapterFile = path.join(root, ADAPTER, 'adapter.json')
    const adapter = JSON.parse(readFileSync(adapterFile, 'utf8')) as Record<string, unknown>
    writeFileSync(adapterFile, JSON.stringify({ ...adapter, [command]: `exec ${String(adapter[command])}` }))
  }

  it('records an object whose success command is killed by a signal as unobserved', () => {
    const root = repository(['alpha'])
    killedBySignal(root, 'success')

    const verdict = run(root, `node scripts/construct/daemon-run.mjs verdict ${ADAPTER} ${RUN} alpha --agent daemon:${RUN}:alpha`)

    expect(verdict.exitCode).toBe(0)
    expect(evidenceOf(root, 'alpha')).toMatchObject({ verdict: 'unobserved', line: 'success ended without an exit code: SIGKILL' })
  })

  it('records an object whose prepare is killed by a signal as unobserved and names the signal', () => {
    const root = repository(['alpha'])
    killedBySignal(root, 'prepare')

    const prepared = run(root, `node scripts/construct/daemon-run.mjs prepare ${ADAPTER} ${RUN} alpha`)

    expect(prepared.exitCode).toBe(0)
    expect(evidenceOf(root, 'alpha')).toMatchObject({ verdict: 'unobserved', line: 'prepare ended without an exit code: SIGKILL: ' })
  })

  it('refuses objects whose listing command is killed by a signal and names the signal', () => {
    const root = repository(['alpha'])
    killedBySignal(root, 'objects')

    const listed = run(root, `node scripts/construct/daemon-run.mjs objects ${ADAPTER}`)

    expect(listed.exitCode).toBe(1)
    expect(listed.stderr).toContain('objects ended without an exit code: SIGKILL')
  })

  it('refuses an objects line whose id is not letters, digits, dot, underscore or dash', () => {
    const root = repository(['alpha', '../escape'])

    const listed = run(root, `node scripts/construct/daemon-run.mjs objects ${ADAPTER}`)

    expect(listed.exitCode).toBe(1)
    expect(listed.stderr).toContain('objects line 2 has no id of letters, digits')
    expect(listed.stdout).toBe('')
  })

  it('refuses an objects line that repeats an id', () => {
    const root = repository(['alpha', 'beta', 'alpha'])

    const listed = run(root, `node scripts/construct/daemon-run.mjs objects ${ADAPTER}`)

    expect(listed.exitCode).toBe(1)
    expect(listed.stderr).toContain('objects line 3 repeats the id alpha')
    expect(listed.stdout).toBe('')
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
    const runDirectory = path.join(projects, projectKey(root), 'session-1', 'subagents', 'workflows', 'wf-1')
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

  it('does not count an evidence.json that parses without a string verdict', () => {
    const projects = scratch('construct-daemon-projects-')
    const root = scratch('construct-daemon-cost-')
    mkdirSync(path.join(projects, projectKey(root)), { recursive: true })
    write(root, `.construct/daemon/${RUN}/missing/evidence.json`, JSON.stringify({ object: 'missing', agent: null }))
    write(root, `.construct/daemon/${RUN}/numeric/evidence.json`, JSON.stringify({ object: 'numeric', verdict: 1, agent: null }))
    write(root, `.construct/daemon/${RUN}/null/evidence.json`, 'null')

    expect(readDaemonObjects(root, projects)).toEqual([])
  })

  it('omits the daemon key of costReport and costJson when no evidence.json exists', () => {
    const projects = scratch('construct-daemon-projects-')
    const root = scratch('construct-daemon-cost-')
    const shiftRoot = scratch('construct-daemon-shift-')
    mkdirSync(path.join(projects, projectKey(root)), { recursive: true })
    mkdirSync(path.join(root, '.construct', 'daemon', RUN, 'alpha'), { recursive: true })

    const report = costReport(root, { projectsDir: projects, shiftRoot, busPath: path.join(shiftRoot, 'bus.db'), env: {}, version: '0' })

    expect('daemon' in report).toBe(false)
    expect('daemon' in costJson(report, false)).toBe(false)
  })

  it('puts the daemon objects under the daemon key of costReport', () => {
    const projects = scratch('construct-daemon-projects-')
    const root = scratch('construct-daemon-cost-')
    const shiftRoot = scratch('construct-daemon-shift-')
    const label = `daemon:${RUN}:alpha`
    mkdirSync(path.join(projects, projectKey(root)), { recursive: true })
    write(root, `.construct/daemon/${RUN}/alpha/evidence.json`, JSON.stringify({ object: 'alpha', verdict: 'holds', agent: label }))

    const report = costReport(root, { projectsDir: projects, shiftRoot, busPath: path.join(shiftRoot, 'bus.db'), env: {}, version: '0' })

    expect(report.daemon).toEqual([{ run: RUN, object: 'alpha', verdict: 'holds', agent: label, tokens: null }])
  })
})

const LAB_SCRIPT = path.join(REPO_ROOT, 'scripts/construct/browser-lab.mjs')

interface HandsCall {
  cwd: string
  args: string[]
}

interface HandsLab {
  root: string
  base: string
  calls: () => HandsCall[]
  hands: (...argv: string[]) => { status: number | null, stderr: string }
}

function handsLab({ failClose = false } = {}): HandsLab {
  const root = realpathSync(scratch('construct-hands-root-'))
  const bin = path.join(root, 'bin')
  const record = path.join(root, 'calls.jsonl')
  write(root, 'extension/manifest.json', '{"manifest_version":3,"name":"sample","version":"1.0.0"}\n')
  write(root, 'base-profile/Default/Preferences', '{}\n')
  write(root, 'bin/npx', '#!/bin/sh\necho "$(dirname "$0")/playwright-cli"\n')
  write(root, 'bin/playwright-cli', [
    '#!/usr/bin/env node',
    'const fs = require(\'node:fs\')',
    'const args = process.argv.slice(2)',
    `fs.appendFileSync(${JSON.stringify(record)}, \`\${JSON.stringify({ cwd: process.cwd(), args })}\\n\`)`,
    'if (args[0] !== \'install-browser\') {',
    '  fs.mkdirSync(\'.playwright-cli\', { recursive: true })',
    '  fs.appendFileSync(\'.playwright-cli/console-1.log\', \'[LOG] \' + args.filter(arg => arg !== \'--config\' && !arg.endsWith(\'hands.config.json\')).join(\' \') + \'\\n\')',
    '}',
    `if (args.includes('close') && fs.existsSync(${JSON.stringify(path.join(root, 'fail-close'))})) process.exit(1)`,
    'console.log(\'ok\')',
    '',
  ].join('\n'))
  if (failClose)
    write(root, 'fail-close', '')
  chmodSync(path.join(bin, 'npx'), 0o755)
  chmodSync(path.join(bin, 'playwright-cli'), 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
  return {
    root,
    base: path.join(root, 'base-profile'),
    calls: () => existsSync(record)
      ? readFileSync(record, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as HandsCall).filter(call => call.args[0] !== 'install-browser')
      : [],
    hands: (...argv) => {
      const ran = spawnSync(process.execPath, [LAB_SCRIPT, 'hands', '--extension', path.join(root, 'extension'), ...argv], { cwd: root, encoding: 'utf8', env })
      return { status: ran.status, stderr: ran.stderr }
    },
  }
}

function userDataDirectory(call: HandsCall): string {
  const config = JSON.parse(readFileSync(call.args[1] as string, 'utf8')) as { browser: { userDataDir: string } }
  return config.browser.userDataDir
}

describe('the hands core of the browser lab', () => {
  it('hands takes --profile-from and copies the base profile per object', () => {
    const lab = handsLab()

    const first = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    const second = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/b', '--', '-s', 'b', 'open', 'http://x')

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    const [profileA, profileB] = lab.calls().map(userDataDirectory) as [string, string]
    expect(profileA).not.toBe(profileB)
    for (const profile of [profileA, profileB]) {
      expect(profile).not.toBe(lab.base)
      expect(existsSync(path.join(profile, 'Default/Preferences'))).toBe(true)
    }
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')
    expect(existsSync(profileA)).toBe(false)
    expect(existsSync(profileB)).toBe(true)
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/b', '--', '-s', 'b', 'close')
    expect(existsSync(profileB)).toBe(false)
    expect(existsSync(path.join(lab.base, 'Default/Preferences'))).toBe(true)
  })

  it('each object gets its own hands session and the extension config whatever the position of -s', () => {
    const lab = handsLab()

    const positions: [string, string[]][] = [['a', ['-s', 'a', 'open', 'http://x']], ['b', ['open', '-s', 'b', 'http://x']], ['c', ['-s=c', 'open', 'http://x']]]
    for (const [object, argv] of positions) {
      const ran = lab.hands('--profile-from', lab.base, '--evidence', `evidence/${object}`, '--', ...argv)
      expect(ran.status, ran.stderr).toBe(0)
      lab.hands('--profile-from', lab.base, '--evidence', `evidence/${object}`, '--', '-s', object, 'close')
    }

    const calls = lab.calls()
    const opens = calls.filter(call => call.args.includes('open'))
    expect(opens.map(call => call.args[0])).toEqual(['--config', '--config', '--config'])
    expect(opens.map(call => call.args.slice(2))).toEqual(positions.map(([, argv]) => argv))
    expect(calls.filter(call => call.args.includes('close')).map(call => call.args[0])).toEqual(['-s', '-s', '-s'])
  })

  it('hands runs under the object evidence directory and leaves no .playwright-cli in the root', () => {
    const lab = handsLab()

    const ran = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')

    expect(ran.status, ran.stderr).toBe(0)
    expect(lab.calls().map(call => call.cwd)).toEqual([path.join(lab.root, 'evidence/a')])
    expect(existsSync(path.join(lab.root, '.playwright-cli'))).toBe(false)
    expect(existsSync(path.join(lab.root, 'evidence/a/.playwright-cli'))).toBe(true)
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')
  })

  it('close writes the full console stream of the hands session into console.json', () => {
    const lab = handsLab()
    const consoleFile = path.join(lab.root, 'evidence/a/console.json')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'click', 'e1')
    expect(existsSync(consoleFile)).toBe(false)

    const closed = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')

    expect(closed.status, closed.stderr).toBe(0)
    expect(JSON.parse(readFileSync(consoleFile, 'utf8'))).toEqual({
      session: 'a',
      console: ['[LOG] -s a open http://x', '[LOG] -s a click e1', '[LOG] -s a close'],
    })
  })

  it('a profile copy left by a session that never closed is swept', () => {
    const lab = handsLab()
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    const [abandoned] = lab.calls().map(userDataDirectory) as [string]
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
    utimesSync(path.join(abandoned, 'hands.config.json'), sevenHoursAgo, sevenHoursAgo)

    const next = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/b', '--', '-s', 'b', 'open', 'http://x')

    expect(next.status, next.stderr).toBe(0)
    expect(existsSync(abandoned)).toBe(false)
    const current = userDataDirectory(lab.calls().at(-1) as HandsCall)
    expect(existsSync(current)).toBe(true)
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/b', '--', '-s', 'b', 'close')
  })

  it('a profile copy whose session is still active is not swept', () => {
    const lab = handsLab()
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    const [active] = lab.calls().map(userDataDirectory) as [string]

    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/b', '--', '-s', 'b', 'open', 'http://x')

    expect(existsSync(active)).toBe(true)
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/b', '--', '-s', 'b', 'close')
  })

  it('close reads only the console logs of its own run', () => {
    const lab = handsLab()
    write(lab.root, 'evidence/a/.playwright-cli/console-0.log', '[LOG] an earlier run\n')
    const consoleFile = path.join(lab.root, 'evidence/a/console.json')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')

    const closed = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')

    expect(closed.status, closed.stderr).toBe(0)
    expect(JSON.parse(readFileSync(consoleFile, 'utf8'))).toEqual({
      session: 'a',
      console: ['[LOG] -s a open http://x', '[LOG] -s a close'],
    })
  })

  it('a failed close writes no console.json', () => {
    const lab = handsLab({ failClose: true })
    write(lab.root, 'evidence/a/console.json', '{"session":"a","console":["[LOG] an earlier run"]}\n')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')

    const closed = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')

    expect(closed.status).toBe(127)
    expect(closed.stderr).toContain('hands failed: exit 1')
    expect(existsSync(path.join(lab.root, 'evidence/a/console.json'))).toBe(false)
  })

  it('a close retried after a failed close still reads only the console logs of its own run', () => {
    const lab = handsLab({ failClose: true })
    write(lab.root, 'evidence/a/.playwright-cli/console-0.log', '[LOG] an earlier run\n')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    const [profile] = lab.calls().map(userDataDirectory) as [string]
    expect(lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close').status).toBe(127)
    expect(existsSync(profile)).toBe(true)
    rmSync(path.join(lab.root, 'fail-close'))

    const retried = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')

    expect(retried.status, retried.stderr).toBe(0)
    expect(JSON.parse(readFileSync(path.join(lab.root, 'evidence/a/console.json'), 'utf8'))).toEqual({
      session: 'a',
      console: ['[LOG] -s a open http://x', '[LOG] -s a close', '[LOG] -s a close'],
    })
    expect(existsSync(profile)).toBe(false)
  })

  it('a close with no record of its open refuses and writes no console.json', () => {
    const lab = handsLab()
    write(lab.root, 'evidence/a/.playwright-cli/console-0.log', '[LOG] an earlier run\n')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    const [profile] = lab.calls().map(userDataDirectory) as [string]
    rmSync(path.join(profile, 'hands.console-before.json'))

    const closed = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')

    expect(closed.status).toBe(127)
    expect(closed.stderr).toContain('no record of the console logs')
    expect(existsSync(path.join(lab.root, 'evidence/a/console.json'))).toBe(false)
    expect(existsSync(profile)).toBe(false)
  })

  it('a session idle for longer than the sweep keeps its own copy and its record of the open', () => {
    const lab = handsLab()
    write(lab.root, 'evidence/a/.playwright-cli/console-0.log', '[LOG] an earlier run\n')
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')
    const [profile] = lab.calls().map(userDataDirectory) as [string]
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
    utimesSync(path.join(profile, 'hands.config.json'), sevenHoursAgo, sevenHoursAgo)

    const resumed = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'click', 'e1')

    expect(resumed.status, resumed.stderr).toBe(0)
    expect(existsSync(path.join(profile, 'hands.console-before.json'))).toBe(true)
    lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')
    expect(JSON.parse(readFileSync(path.join(lab.root, 'evidence/a/console.json'), 'utf8')).console).toEqual(['[LOG] -s a open http://x', '[LOG] -s a click e1', '[LOG] -s a close'])
  })

  it('a stale copy the sweep cannot remove does not stop the hands run', () => {
    const lab = handsLab()
    const stuck = path.join(realpathSync(tmpdir()), `browser-lab-hands-stuck-${path.basename(lab.root)}`)
    write(stuck, 'locked/file', 'x')
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
    utimesSync(stuck, sevenHoursAgo, sevenHoursAgo)
    chmodSync(path.join(stuck, 'locked'), 0o555)
    try {
      const ran = lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'open', 'http://x')

      expect(ran.status, ran.stderr).toBe(0)
      expect(existsSync(path.join(stuck, 'locked/file'))).toBe(true)
      lab.hands('--profile-from', lab.base, '--evidence', 'evidence/a', '--', '-s', 'a', 'close')
    }
    finally {
      chmodSync(path.join(stuck, 'locked'), 0o755)
      rmSync(stuck, { recursive: true, force: true })
    }
  })
})
