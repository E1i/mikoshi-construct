import type { GhSpawned } from '../../core/gh.js'
import { describe, expect, it } from 'vitest'
import { GhBudgetWindow, ghPort } from '../../core/gh.js'
import { downloadStageRecord, requestCancel, runIdentityFrom } from '../../release/cancel-run.js'

const RUN = { repository: 'E1i/mikoshi-construct', runId: '42' }

const ran = (stdout = ''): GhSpawned => ({ status: 0, stdout, stderr: '' })
const refused = (stderr: string): GhSpawned => ({ status: 1, stdout: '', stderr })

function portOver(runs: GhSpawned[]) {
  const calls: string[][] = []
  const port = ghPort({ spawn: (_command, args) => {
    calls.push(args)
    return runs.shift() ?? ran()
  }, pause: () => {}, budget: new GhBudgetWindow({ calls: 100, windowMs: 1000 }, () => 0) })
  return { port, calls }
}

describe('a pending verification cancels its own run', () => {
  it('names its own run from the Actions environment', () => {
    expect(runIdentityFrom({ GITHUB_REPOSITORY: 'E1i/mikoshi-construct', GITHUB_RUN_ID: '42', GH_TOKEN: 'token-from-env' })).toEqual(RUN)
  })

  it('has no run to cancel outside Actions or without a token', () => {
    expect(runIdentityFrom({})).toBeUndefined()
    expect(runIdentityFrom({ GITHUB_REPOSITORY: 'E1i/mikoshi-construct', GITHUB_RUN_ID: '42' })).toBeUndefined()
  })

  it('asks the gh port for the cancellation of exactly its own run', () => {
    const { port, calls } = portOver([ran()])
    expect(requestCancel(RUN, port)).toBe(true)
    expect(calls).toEqual([['run', 'cancel', '42', '--repo', 'E1i/mikoshi-construct']])
  })

  it('reads a refused cancellation as not cancelled, so the run cannot end green', () => {
    const { port } = portOver([refused('HTTP 409: Cannot cancel a workflow run that is completed.')])
    expect(requestCancel(RUN, port)).toBe(false)
  })
})

describe('the stage record of the Release run comes through the gh port', () => {
  it('downloads the release-stage artifact when the Release run uploaded one', () => {
    const { port, calls } = portOver([ran('{"total_count":1}'), ran()])
    expect(downloadStageRecord(RUN, port)).toBe(true)
    expect(calls).toEqual([
      ['api', 'repos/E1i/mikoshi-construct/actions/runs/42/artifacts?name=release-stage'],
      ['run', 'download', '42', '--repo', 'E1i/mikoshi-construct', '--name', 'release-stage', '--dir', 'release-stage'],
    ])
  })

  it('downloads nothing when the Release run uploaded no stage record', () => {
    const { port, calls } = portOver([ran('{"total_count":0}')])
    expect(downloadStageRecord(RUN, port)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('fails the verification when the artifacts cannot be listed or the download fails', () => {
    expect(() => downloadStageRecord(RUN, portOver([refused('HTTP 404: Not Found')]).port)).toThrow(/could not be listed/)
    expect(() => downloadStageRecord(RUN, portOver([ran('{"total_count":1}'), refused('no artifact matches')]).port)).toThrow(/could not be downloaded/)
  })
})
