import type { RunIdentity } from '../ports/ci-reading.js'
import type { GhPort } from '../ports/gh.js'
import { GhCiRuns } from '../ports/ci-reading.js'
import { PROCESS_GH_PORT } from '../ports/gh.js'
import { STAGE_ARTIFACT } from './stage.js'

export type { RunIdentity } from '../ports/ci-reading.js'

export function runIdentityFrom(env: Record<string, string | undefined>): RunIdentity | undefined {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GH_TOKEN: token } = env
  if (!repository || !runId || !token)
    return undefined
  return { repository, runId }
}

export function requestCancel(run: RunIdentity, port: GhPort = PROCESS_GH_PORT): boolean {
  return new GhCiRuns(port).cancel(run)
}

export function downloadStageRecord(release: RunIdentity, port: GhPort = PROCESS_GH_PORT): boolean {
  const ci = new GhCiRuns(port)
  const artifacts = ci.artifactsNamed(release, STAGE_ARTIFACT)
  if (artifacts.kind === 'failed')
    throw new Error(`the artifacts of run ${release.runId} could not be listed: ${artifacts.reason}`)
  if (artifacts.value === 0)
    return false
  const downloaded = ci.downloadArtifact(release.runId, { name: STAGE_ARTIFACT, dir: STAGE_ARTIFACT, repository: release.repository })
  if (!downloaded.done)
    throw new Error(`the ${STAGE_ARTIFACT} artifact of run ${release.runId} could not be downloaded: ${downloaded.reason}`)
  return true
}
