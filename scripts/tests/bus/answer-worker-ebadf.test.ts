import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnClient } from '../../nodes/answer/duties/index.js'

const SPEAKS_AFTER_ABORT_MS = 150
const CHILD_ENDS_MS = 400
const CLIENT_THAT_OUTLIVES_ITS_ABORT = [
  `process.on('SIGTERM', () => {})`,
  `process.stdout.write('before\\n')`,
  `setTimeout(() => process.stdout.write('after the abort\\n'), ${SPEAKS_AFTER_ABORT_MS})`,
  `setTimeout(() => process.exit(0), ${CHILD_ENDS_MS})`,
].join(';')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function runFolder(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'answer-ebadf-'))
  roots.push(root)
  return root
}

async function settled(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('the answer client run', () => {
  it('a closed descriptor does not kill the answer worker', async () => {
    const root = runFolder()
    const stdoutPath = path.join(root, 'stdout.log')
    const abort = new AbortController()
    const lines: string[] = []
    const uncaught: unknown[] = []
    const keep = (error: unknown): void => {
      uncaught.push(error)
    }
    process.prependListener('uncaughtException', keep)
    try {
      const run = spawnClient({
        cwd: root,
        command: process.execPath,
        argv: ['-e', CLIENT_THAT_OUTLIVES_ITS_ABORT],
        stdoutPath,
        stderrPath: path.join(root, 'stderr.log'),
        env: process.env,
        signal: abort.signal,
        onLine: line => lines.push(line),
      })
      await settled(50)
      abort.abort()

      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      await settled(CHILD_ENDS_MS)

      expect(uncaught).toEqual([])
      expect(lines).not.toContain('after the abort')
      expect(readFileSync(stdoutPath, 'utf8')).not.toContain('after the abort')
    }
    finally {
      process.removeListener('uncaughtException', keep)
    }
  })
})
