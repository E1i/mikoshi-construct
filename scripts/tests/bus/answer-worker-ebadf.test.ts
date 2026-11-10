import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnClient } from '../../nodes/answer/duties/index.js'
import { waitFor } from '../wait-for.js'

const SPEAKS_AFTER_ABORT_MS = 150
const CHILD_ENDS_MS = 400
const CHILD_ENDED_WITHIN_MS = 10_000

function clientThatOutlivesItsAbort(endedFile: string): string {
  return [
    `process.on('SIGTERM', () => {})`,
    `process.stdout.write('before\\n')`,
    `setTimeout(() => process.stdout.write('after the abort\\n'), ${SPEAKS_AFTER_ABORT_MS})`,
    `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(endedFile)}, ''); process.exit(0) }, ${CHILD_ENDS_MS})`,
  ].join(';')
}

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

describe('the answer client run', () => {
  it('a closed descriptor does not kill the answer worker', async () => {
    const root = runFolder()
    const stdoutPath = path.join(root, 'stdout.log')
    const abort = new AbortController()
    const endedFile = path.join(root, 'ended')
    const lines: string[] = []
    let spoke: () => void = () => {}
    const firstLine = new Promise<void>((resolve) => {
      spoke = resolve
    })
    const uncaught: unknown[] = []
    const keep = (error: unknown): void => {
      uncaught.push(error)
    }
    process.prependListener('uncaughtException', keep)
    try {
      const run = spawnClient({
        cwd: root,
        command: process.execPath,
        argv: ['-e', clientThatOutlivesItsAbort(endedFile)],
        stdoutPath,
        stderrPath: path.join(root, 'stderr.log'),
        env: process.env,
        signal: abort.signal,
        onLine: (line) => {
          lines.push(line)
          spoke()
        },
      })
      await firstLine
      abort.abort()

      await expect(run).rejects.toMatchObject({ name: 'AbortError' })
      await waitFor(() => existsSync(endedFile), () => `the client to end and write ${endedFile}`, CHILD_ENDED_WITHIN_MS)

      expect(uncaught).toEqual([])
      expect(lines).not.toContain('after the abort')
      expect(readFileSync(stdoutPath, 'utf8')).not.toContain('after the abort')
    }
    finally {
      process.removeListener('uncaughtException', keep)
    }
  })
})
