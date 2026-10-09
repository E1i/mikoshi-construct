import { spawnSync } from 'node:child_process'

export interface GhResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export type GitHub = (endpoint: string) => GhResponse

export const RATE_LIMIT_STATUSES = new Set([403, 429])

const STATUS_LINE = /^HTTP\/\S+\s+(\d{3})/
const GH_TIMEOUT_MS = 20_000

export function parseIncluded(output: string): GhResponse {
  const normalised = output.replace(/\r\n/g, '\n')
  const split = normalised.indexOf('\n\n')
  const head = split === -1 ? normalised : normalised.slice(0, split)
  const text = split === -1 ? '' : normalised.slice(split + 2).trim()
  const [statusLine = '', ...headerLines] = head.split('\n')
  const status = STATUS_LINE.exec(statusLine)
  if (status === null)
    throw new Error(`gh api printed no HTTP status line: ${statusLine}`)
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  let body: unknown = text
  try {
    body = text === '' ? null : JSON.parse(text)
  }
  catch {}
  return { status: Number(status[1]), headers, body }
}

export function ghApi(cwd: string, command = 'gh'): GitHub {
  return (endpoint) => {
    const run = spawnSync(command, ['api', '--include', '--method', 'GET', endpoint], { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL' })
    if (run.error !== undefined)
      throw run.error
    if (run.stdout.trim() === '')
      throw new Error(`gh api ${endpoint} printed nothing: ${run.stderr.trim()}`)
    return parseIncluded(run.stdout)
  }
}
