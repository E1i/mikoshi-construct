export interface RunIdentity {
  repository: string
  runId: string
  token: string
}

export type CancelRequest = (url: string, init: RequestInit) => Promise<Response>

export function runIdentityFrom(env: Record<string, string | undefined>): RunIdentity | undefined {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GH_TOKEN: token } = env
  if (!repository || !runId || !token)
    return undefined
  return { repository, runId, token }
}

export async function requestCancel(run: RunIdentity, request: CancelRequest): Promise<boolean> {
  try {
    const response = await request(`https://api.github.com/repos/${run.repository}/actions/runs/${run.runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${run.token}`, accept: 'application/vnd.github+json' },
    })
    return response.status === 202
  }
  catch {
    return false
  }
}
