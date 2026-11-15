import type { AnswerRun } from '../../nodes/answer/duties/index.js'
import { readShiftGate } from '../../../src/manifest.js'

function bashUse(id: string, command: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
}

function bashResult(id: string, isError: boolean, content: string): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } })
}

export function gateLines(commands: readonly string[], isError = false, content = 'green'): string[] {
  return commands.flatMap((command, index) => [bashUse(`gate-${index}`, command), bashResult(`gate-${index}`, isError, content)])
}

export function ranTheGreenGate(run: Pick<AnswerRun, 'cwd' | 'onLine'>): void {
  gateLines(readShiftGate(run.cwd).prepush).forEach(line => run.onLine?.(line))
}
