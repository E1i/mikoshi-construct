import type { GhPort } from '../ports/gh.js'
import { PROCESS_GH_PORT, readGhJson } from '../ports/gh.js'
import { STAGE_ARTIFACT } from './stage.js'

export interface RunIdentity {
  repository: string
  runId: string
}

export function runIdentityFrom(env: Record<string, string | undefined>): RunIdentity | undefined {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GH_TOKEN: token } = env
  if (!repository || !runId || !token)
    return undefined
  return { repository, runId }
}

export function requestCancel(run: RunIdentity, port: GhPort = PROCESS_GH_PORT): boolean {
  return port.call(['run', 'cancel', run.runId, '--repo', run.repository]).kind === 'ran'
}

export function downloadStageRecord(release: RunIdentity, port: GhPort = PROCESS_GH_PORT): boolean {
  const artifacts = readGhJson<{ total_count?: number }>(args => port.call(args), ['api', `repos/${release.repository}/actions/runs/${release.runId}/artifacts?name=${STAGE_ARTIFACT}`])
  if (artifacts.kind === 'failed')
    throw new Error(`the artifacts of run ${release.runId} could not be listed: ${artifacts.reason}`)
  if ((artifacts.value.total_count ?? 0) === 0)
    return false
  const downloaded = port.call(['run', 'download', release.runId, '--repo', release.repository, '--name', STAGE_ARTIFACT, '--dir', STAGE_ARTIFACT])
  if (downloaded.kind === 'failed')
    throw new Error(`the ${STAGE_ARTIFACT} artifact of run ${release.runId} could not be downloaded: ${downloaded.reason}`)
  return true
}
