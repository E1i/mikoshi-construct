import type { Card } from './grammar.js'
import { parseCard } from './grammar.js'

export const CONTINUE_MODES = ['auto', 'stop'] as const

export type ContinueMode = typeof CONTINUE_MODES[number]

export interface ShiftTask {
  file: string
  number: string
  id: string
  card: Card
  branch: string
  touches: string[]
  body: string
  continue: ContinueMode
}

export type ParsedTaskFile = { kind: 'task', task: ShiftTask } | { kind: 'refused', reason: string }

export const TASK_FILE = /^(\d+)\.md$/
const REQUIRED_KEYS = ['card', 'branch', 'touches'] as const
const KEYS = [...REQUIRED_KEYS, 'continue'] as const
const DEFAULT_CONTINUE: ContinueMode = 'stop'
const HEADER_LINE = /^([a-z]+):(.*)$/
export const PREFIX_SUFFIX = '/**'

function refused(file: string, reason: string): ParsedTaskFile {
  return { kind: 'refused', reason: `${file}: ${reason}` }
}

export function touchError(entry: string): string | null {
  const scope = entry.endsWith(PREFIX_SUFFIX) ? entry.slice(0, -PREFIX_SUFFIX.length) : entry
  if (scope === '')
    return `touches entry '${entry}' names no path`
  if (scope.includes('*'))
    return `touches entry '${entry}' may use '*' only as a trailing '/**'`
  if (scope.startsWith('/') || scope.split('/').some(segment => segment === '..' || segment === '.' || segment === ''))
    return `touches entry '${entry}' must be a relative path inside the repository`
  return null
}

export function parseTaskFile(file: string, text: string): ParsedTaskFile {
  const number = TASK_FILE.exec(file)?.[1]
  if (number === undefined)
    return refused(file, 'a task file is named NN.md')
  const lines = text.split('\n')
  const blank = lines.findIndex(line => line.trim() === '')
  const headerLines = blank === -1 ? lines : lines.slice(0, blank)
  const header = new Map<string, string>()
  for (const line of headerLines) {
    const match = HEADER_LINE.exec(line.trim())
    if (match === null)
      return refused(file, `header line '${line}' is not 'key: value'`)
    const [, key, value] = match as unknown as [string, string, string]
    if (key === 'task')
      return refused(file, `'task:' is replaced by 'card: <the task's card>'; the id is the card's #<id>`)
    if (!(KEYS as readonly string[]).includes(key))
      return refused(file, `unknown header key '${key}'; the keys are ${KEYS.join(', ')}`)
    if (header.has(key))
      return refused(file, `header key '${key}' appears twice`)
    header.set(key, value.trim())
  }
  const missing = REQUIRED_KEYS.filter(key => (header.get(key) ?? '') === '')
  if (missing.length > 0)
    return refused(file, `header is missing ${missing.join(', ')}`)
  const continueMode = header.get('continue') ?? DEFAULT_CONTINUE
  if (!(CONTINUE_MODES as readonly string[]).includes(continueMode))
    return refused(file, `continue '${continueMode}' is not one of ${CONTINUE_MODES.join(', ')}`)
  const card = parseCard(header.get('card')!)
  if (card.kind === 'refused')
    return refused(file, `card refused: ${card.reason}`)
  const touches = header.get('touches')!.split(',').map(entry => entry.trim())
  const touchErrors = touches.map(touchError).filter(error => error !== null)
  if (touchErrors.length > 0)
    return refused(file, touchErrors.join('; '))
  const body = blank === -1 ? '' : lines.slice(blank + 1).join('\n').trim()
  if (body === '')
    return refused(file, 'the prompt body after the first blank line is empty')
  return { kind: 'task', task: { file, number, id: String(card.card.id), card: card.card, branch: header.get('branch')!, touches, body, continue: continueMode as ContinueMode } }
}
