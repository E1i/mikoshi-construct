import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runClaude } from '../../shift/claude.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function stubWorld(): { root: string, stub: string, pidFile: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-claude-')))
  roots.push(root)
  const stub = path.join(root, 'claude-stub')
  const pidFile = path.join(root, 'pid')
  writeFileSync(stub, `#!/bin/sh\necho $$ > "${pidFile}"\ncat > /dev/null\n`)
  chmodSync(stub, 0o755)
  return { root, stub, pidFile }
}

async function spawnedAndRecorded(command: (stub: string) => string): Promise<{ spawned: number[], recorded: number }> {
  const w = stubWorld()
  const spawned: number[] = []
  const exit = await runClaude({ command: command(w.stub), cwd: w.root, sessionId: 's-1', prompt: 'prompt', log: path.join(w.root, 'log'), onSpawn: pid => spawned.push(pid) })
  expect(exit).toEqual({ kind: 'exited', code: 0, signal: null })
  return { spawned, recorded: Number(readFileSync(w.pidFile, 'utf8').trim()) }
}

describe('runClaude', () => {
  it('the pid it spawns is the claude process itself, with or without a leading assignment', async () => {
    for (const command of [(stub: string) => stub, (stub: string) => `GH_TOKEN=$(echo token-of-E1i) ${stub} --permission-mode auto`]) {
      const { spawned, recorded } = await spawnedAndRecorded(command)
      expect(spawned).toEqual([recorded])
    }
  })
})
