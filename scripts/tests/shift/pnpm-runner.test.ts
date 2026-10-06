import { describe, expect, it } from 'vitest'
import { runPnpmCommand } from '../../shift/shift.js'

const HERE = import.meta.dirname

describe('the pnpm runner the shift wires into a real run', () => {
  it('hands its input to the command on stdin and returns what it printed', () => {
    expect(runPnpmCommand(HERE, ['exec', 'node', '-e', 'process.stdin.pipe(process.stdout)'], 'yes\n')).toMatchObject({ code: 0, stdout: 'yes\n' })
  })

  it('returns the exit code and the stderr of a command that fails, without throwing', () => {
    const result = runPnpmCommand(HERE, ['exec', 'node', '-e', 'console.error("refused"); process.exit(3)'])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('refused')
  })
})
