import type { GhCall, GhPort } from '../core/gh.js'
import { PROCESS_GH_PORT } from '../core/gh.js'

export interface GhResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export type GitHub = (endpoint: string) => GhResponse

export const RATE_LIMIT_STATUSES = new Set([403, 429])
export const BUDGET_SPENT_STATUS = 429
export const NO_ANSWER_STATUS = 599

const STATUS_LINE = /^HTTP\/\S+\s+(\d{3})/

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

export type GitHubPut = (endpoint: string, fields: Record<string, string>) => GhResponse

function technical(endpoint: string, result: GhCall): GhResponse {
  if (result.kind === 'failed' && result.cause === 'budget')
    return { status: BUDGET_SPENT_STATUS, headers: { 'retry-after': String(result.retryAfterSeconds ?? 0) }, body: { message: `gh api ${endpoint}: ${result.reason}` } }
  return { status: NO_ANSWER_STATUS, headers: {}, body: { message: result.kind === 'failed' ? `gh api ${endpoint}: ${result.reason}` : `gh api ${endpoint} printed nothing` } }
}

function included(port: GhPort, cwd: string, args: string[], endpoint: string): GhResponse {
  const result = port.call(['api', '--include', ...args], { cwd })
  if (result.stdout.trim() === '')
    return technical(endpoint, result)
  try {
    return parseIncluded(result.stdout)
  }
  catch (error) {
    return { status: NO_ANSWER_STATUS, headers: {}, body: { message: `gh api ${endpoint}: ${error instanceof Error ? error.message : String(error)}` } }
  }
}

export function ghApi(cwd: string, port: GhPort = PROCESS_GH_PORT): GitHub {
  return endpoint => included(port, cwd, ['--method', 'GET', endpoint], endpoint)
}

export function ghApiPut(cwd: string, port: GhPort = PROCESS_GH_PORT): GitHubPut {
  return (endpoint, fields) => included(port, cwd, ['--method', 'PUT', endpoint, ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])], endpoint)
}
