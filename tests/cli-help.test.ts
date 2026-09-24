import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, VERSION_PLACEHOLDER, withVersionPlaceholder } from './cli-process.js'

const SNAPSHOTS = path.join(import.meta.dirname, 'fixtures/cli-help')
const COMMANDS = ['main', 'init', 'attach', 'detach', 'doctor', 'sync', 'cost', 'graph', 'soulkill']
const SUBCOMMANDS = ['mutate apply', 'mutate judge']

function snapshotOf(command: string): string {
  return readFileSync(path.join(SNAPSHOTS, `${command.replaceAll(' ', '-')}.txt`), 'utf8')
}

describe.concurrent('--help of every command matches its frozen snapshot, with the version as the one normalisation', () => {
  for (const command of COMMANDS) {
    it(command, async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'construct-help-'))
      const result = await runCli(command === 'main' ? ['--help'] : [command, '--help'], home)
      const frozen = snapshotOf(command)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(frozen.split(VERSION_PLACEHOLDER)).toHaveLength(2)
      expect(withVersionPlaceholder(result.stdout)).toBe(frozen)
    })
  }
})

describe.concurrent('--help of every subcommand matches its frozen snapshot, and its header names the parent and no version', () => {
  for (const command of SUBCOMMANDS) {
    it(command, async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'construct-help-'))
      const result = await runCli([...command.split(' '), '--help'], home)
      const frozen = snapshotOf(command)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(frozen.split('\n')[0].endsWith(`(${command})`)).toBe(true)
      expect(frozen).not.toContain(VERSION_PLACEHOLDER)
      expect(result.stdout).toBe(frozen)
    })
  }
})
