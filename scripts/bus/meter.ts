import type { GhResponse, GitHub } from './github.js'
import { RATE_LIMIT_STATUSES } from './github.js'

export const DEFAULT_RETRY_AFTER_S = 60

export class RateLimited extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds: number) {
    super(`GitHub answered ${status}; retry after ${retryAfterSeconds} s`)
  }
}

export class GitHubFailed extends Error {
  constructor(readonly status: number, endpoint: string) {
    super(`GitHub answered ${status} to ${endpoint}`)
  }
}

function headerNumber(response: GhResponse, name: string): number | null {
  const value = response.headers[name]
  return value === undefined || value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)
}

export function retryAfterSeconds(response: GhResponse, nowMs: number): number {
  const retryAfter = headerNumber(response, 'retry-after')
  if (retryAfter !== null)
    return Math.max(0, Math.ceil(retryAfter))
  const reset = headerNumber(response, 'x-ratelimit-reset')
  if (headerNumber(response, 'x-ratelimit-remaining') === 0 && reset !== null)
    return Math.max(0, Math.ceil(reset - nowMs / 1000))
  return DEFAULT_RETRY_AFTER_S
}

export class Meter {
  calls = 0
  remaining: number | null = null

  constructor(private readonly gitHub: GitHub, private readonly nowMs: () => number) {}

  get(endpoint: string): unknown {
    this.calls += 1
    const response = this.gitHub(endpoint)
    this.remaining = headerNumber(response, 'x-ratelimit-remaining') ?? this.remaining
    if (RATE_LIMIT_STATUSES.has(response.status))
      throw new RateLimited(response.status, retryAfterSeconds(response, this.nowMs()))
    if (response.status >= 400)
      throw new GitHubFailed(response.status, endpoint)
    return response.body
  }
}
