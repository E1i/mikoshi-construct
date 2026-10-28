import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentOptions, Evidence } from './daemon-workflow.js'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { commandOf, CORE, evidenceDirectoryOf, REPO_ROOT, run, runWorkflow } from './daemon-workflow.js'

const FIXTURE = path.join(import.meta.dirname, 'fixtures/daemon-run')
const ADAPTER = '.construct/daemon/fixture'
const LAB = 'scripts/construct/browser-lab.mjs'
const BROWSER_LAB_RUNS = process.env.BROWSER_LAB === '1'
const HANDS_RUN_MS = 120_000
const DAEMON_RUN_MS = 480_000
const CONSOLE_TRIES = 5
const CONSOLE_PAUSE_MS = 1000
const FIXTURE_LINE = 'daemon-fixture:'

interface HandsRun {
  status: number | null
  stdout: string
  stderr: string
  output: string
}

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

function fixtureRepository(): string {
  const root = scratch('construct-daemon-fixture-')
  for (const file of [...CORE, LAB])
    cpSync(path.join(REPO_ROOT, file), path.join(root, file))
  cpSync(path.join(FIXTURE, 'extension'), path.join(root, 'extension'), { recursive: true })
  cpSync(path.join(FIXTURE, 'adapter'), path.join(root, ADAPTER), { recursive: true })
  return root
}

function outputOf(stdout: string): string {
  try {
    return String((JSON.parse(stdout) as { output?: unknown }).output ?? '')
  }
  catch {
    return ''
  }
}

function labCopyOf(prompt: string): string {
  const match = prompt.match(/ hands --extension '([^']+)'/)
  if (match?.[1] == null)
    throw new Error(`no lab copy in the prompt: ${prompt}`)
  return match[1]
}

function refOfGo(root: string, snapshotOutput: string): string | undefined {
  const linked = snapshotOutput.match(/\[Snapshot\]\(([^)]+)\)/)?.[1]
  const snapshot = linked === undefined ? snapshotOutput : readFileSync(path.resolve(root, linked), 'utf8')
  return snapshot.match(/button "Go" \[ref=([^\]]+)\]/)?.[1]
}

async function standInMechanic(root: string, prompt: string, object: string, page: string, profile: string, transcript: string[]): Promise<string> {
  const evidence = path.join(root, evidenceDirectoryOf(prompt))
  mkdirSync(evidence, { recursive: true })
  const extension = labCopyOf(prompt)
  const session = `-s=${object}`
  let outputs = 0
  function hands(...cliArguments: string[]): HandsRun {
    const ran = spawnSync(process.execPath, [LAB, 'hands', '--extension', extension, '--profile', profile, '--', ...cliArguments], { cwd: root, encoding: 'utf8', timeout: HANDS_RUN_MS })
    outputs += 1
    writeFileSync(path.join(evidence, `lab-${outputs}.json`), ran.stdout)
    transcript.push(`${object} hands ${cliArguments.join(' ')}: exit ${String(ran.status)}\nstdout: ${ran.stdout}\nstderr: ${ran.stderr}`)
    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, output: outputOf(ran.stdout) }
  }
  try {
    hands('open', session, page)
    const ref = refOfGo(root, hands('snapshot', session).output)
    if (ref === undefined)
      return 'no button named Go in the snapshot'
    hands('click', session, ref)
    let heard = hands('console', session)
    for (let tries = 1; tries < CONSOLE_TRIES && !heard.output.includes(FIXTURE_LINE); tries++) {
      await sleep(CONSOLE_PAUSE_MS)
      heard = hands('console', session)
    }
    writeFileSync(path.join(evidence, 'console.json'), heard.stdout)
    return `clicked ${ref} and read the console`
  }
  finally {
    hands('close', session)
  }
}

function evidenceOf(root: string, runId: string, object: string): Evidence {
  return JSON.parse(readFileSync(path.join(root, '.construct/daemon', runId, object, 'evidence.json'), 'utf8')) as Evidence
}

describe('the fixture adapter', () => {
  it('holds to the contract and lists the object it substitutes and the one it leaves as shipped', () => {
    const root = fixtureRepository()

    const listed = run(root, `node scripts/construct/daemon-run.mjs objects ${ADAPTER}`)

    expect(listed.exitCode, listed.stderr).toBe(0)
    expect((JSON.parse(listed.stdout) as { objects: string[] }).objects).toEqual(['substituted', 'untouched'])
  })
})

describe.runIf(BROWSER_LAB_RUNS)('a daemon run over the fixture adapter in a real browser', () => {
  let server: Server
  let page: string

  beforeAll(async () => {
    const html = readFileSync(path.join(FIXTURE, 'page.html'), 'utf8')
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(html)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    page = `http://127.0.0.1:${(server.address() as AddressInfo).port}/covered/`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  it('holds for the object whose prepare substituted the config and is false for the one whose prepare did not', async () => {
    const root = fixtureRepository()
    const profiles = scratch('construct-daemon-fixture-profiles-')
    const transcript: string[] = []
    async function agent(prompt: string, options: AgentOptions = {}): Promise<unknown> {
      if (options.schema != null)
        return run(root, commandOf(prompt))
      const object = (options.label ?? '').split(':').at(-1) ?? ''
      return standInMechanic(root, prompt, object, page, path.join(profiles, object), transcript)
    }

    const result = await runWorkflow({ adapter: ADAPTER, limit: 1 }, agent)

    const said = transcript.join('\n\n')
    const directory = `.construct/daemon/${result.run}`
    expect(result.status, said).toBe('done')
    expect(evidenceOf(root, result.run, 'substituted'), said).toMatchObject({
      verdict: 'holds',
      line: 'daemon-fixture: substituted',
      lab: expect.arrayContaining([`${directory}/substituted/lab-1.json`]) as string[],
      console: `${directory}/substituted/console.json`,
      agent: `daemon:${result.run}:substituted`,
    })
    expect(evidenceOf(root, result.run, 'untouched'), said).toMatchObject({
      verdict: 'false',
      line: 'daemon-fixture: shipped',
      lab: expect.arrayContaining([`${directory}/untouched/lab-1.json`]) as string[],
      console: `${directory}/untouched/console.json`,
      agent: `daemon:${result.run}:untouched`,
    })
  }, DAEMON_RUN_MS)
})
