import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const SEQUENCES_FILE = 'scripts/tests/bus/review-queue.test.ts'
const SEQUENCES_TEST = 'one pull request keeps exactly one live review'
const SEQUENCES_LIMIT_MS = 120_000
const PARALLEL_COPIES = 4
const SPAWN_AND_TRANSFORM_MS = 60_000
const COPY_KILLED_AFTER_MS = SEQUENCES_LIMIT_MS + SPAWN_AND_TRANSFORM_MS
const WAIT_FOR_THE_KILLED_COPIES_MS = 30_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Outcome {
  title: string
  status: string
  duration: number
}

interface CopyResult {
  code: number | null
  outcomes: Outcome[]
}

function environmentOfAFreshVitest(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST') && name !== 'NODE_ENV'))
}

function ranOutcomesOf(report: string): Outcome[] {
  if (!existsSync(report))
    return []
  const parsed = JSON.parse(readFileSync(report, 'utf8')) as { testResults: { assertionResults: Outcome[] }[] }
  return parsed.testResults.flatMap(file => file.assertionResults).filter(outcome => outcome.status !== 'skipped' && outcome.status !== 'pending')
}

async function runACopy(): Promise<CopyResult> {
  const root = mkdtempSync(path.join(tmpdir(), 'review-queue-load-'))
  roots.push(root)
  const report = path.join(root, 'report.json')
  return new Promise((resolve) => {
    const args = [VITEST, 'run', SEQUENCES_FILE, '-t', SEQUENCES_TEST, '--reporter=json', `--outputFile.json=${report}`]
    execFile(process.execPath, args, { cwd: ROOT, env: environmentOfAFreshVitest(), timeout: COPY_KILLED_AFTER_MS, maxBuffer: 64 * 1024 * 1024 }, (error) => {
      resolve({ code: error === null ? 0 : (typeof error.code === 'number' ? error.code : null), outcomes: ranOutcomesOf(report) })
    })
  })
}

describe('review queue under load', () => {
  it('the sequences test finishes inside its 120 s limit with parallel copies of itself as background load', async () => {
    const copies = await Promise.all(Array.from({ length: PARALLEL_COPIES }, runACopy))

    expect(copies.map(copy => ({ code: copy.code, outcomes: copy.outcomes.map(outcome => ({ title: outcome.title, status: outcome.status, inside: outcome.duration < SEQUENCES_LIMIT_MS })) }))).toEqual(Array.from({ length: PARALLEL_COPIES }, () => ({ code: 0, outcomes: [{ title: expect.stringContaining(SEQUENCES_TEST), status: 'passed', inside: true }] })))
  }, COPY_KILLED_AFTER_MS + WAIT_FOR_THE_KILLED_COPIES_MS)
})
