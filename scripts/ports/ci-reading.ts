import type { ArtifactRequest, CheckRun, CommitCi, FailedJobLog, PrDetails, PullRequestView, RollupCheck, RunIdentity } from '../../src/commands/ci/state.js'
import type { GhPort, GhRead, PullRequest } from './gh.js'
import type { Meter } from './meter.js'
import { artifactDownloadArgs, artifactsOfRunArgs, ciOfRollup, commitCi, commitCiOfRuns, detailsOfPullRequestView, failedJobLog, hasApprovedRun, jobsOfRunArgs, pullRequestViewArgs, REQUIRED_CHECK, runCancelArgs, shortHead, successfulRunsOnMainArgs, unreadPullRequest } from '../../src/commands/ci/state.js'
import { GH_QUERY_FAILED, PROCESS_GH_PORT, readGhJson } from './gh.js'

export { CI_LOG_CEILING, ciFieldsOfObservation, ciLogForPrompt, ciOf, ciWord, failedJobLinkIn, rerunFailedJobsEndpoint, runsOnHeadEndpoint } from '../../src/commands/ci/state.js'
export type { ArtifactRequest, CheckRun, CiObservation, CiReading, CiState, CommitCi, FailedJobLog, PrDetails, RollupCheck, RunIdentity } from '../../src/commands/ci/state.js'

export interface RunOnMain {
  databaseId: number
  headSha: string
}

export interface RunStep {
  name: string
  startedAt: string
  completedAt: string
}

export interface RunJob {
  name: string
  conclusion: string
  startedAt: string
  completedAt: string
  steps?: RunStep[]
}

export type CiRead<T> = GhRead<T>

export type CiAct = { done: true } | { done: false, reason: string }

export interface CiOfCommits {
  onCommit: (sha: string, requiredCheck?: string) => CommitCi
  approvedRunOn: (head: string | undefined) => boolean
}

export interface CiRuns {
  pullRequest: (pr: PullRequest, repository: string) => PrDetails
  failureLogOn: (head: string, tree: string) => FailedJobLog | null
  successfulRunsOnMain: (limit: number) => CiRead<RunOnMain[]>
  jobsOfRun: (runId: number) => CiRead<{ jobs: RunJob[] }>
  artifactsNamed: (run: RunIdentity, name: string) => CiRead<number>
  downloadArtifact: (runId: string | number, artifact: ArtifactRequest) => CiAct
  cancel: (run: RunIdentity) => boolean
}

export class GitHubCommitCi implements CiOfCommits {
  constructor(private readonly meter: Meter) {}

  onCommit(sha: string, requiredCheck = REQUIRED_CHECK): CommitCi {
    return commitCi(this.meter, sha, requiredCheck)
  }

  approvedRunOn(head: string | undefined): boolean {
    return hasApprovedRun(this.meter, head)
  }
}

export class GhCiRuns implements CiRuns {
  constructor(private readonly gh: GhPort = PROCESS_GH_PORT) {}

  private read<T>(args: string[]): CiRead<T> {
    return readGhJson<T>(call => this.gh.call(call), args)
  }

  pullRequest(pr: PullRequest, repository: string): PrDetails {
    const view = this.read<PullRequestView>(pullRequestViewArgs(pr.number, repository))
    if (view.kind === 'failed')
      return unreadPullRequest(view.cause === 'timeout' ? view.reason : GH_QUERY_FAILED, pr.headRefOid)
    return detailsOfPullRequestView(view.value, pr.headRefOid)
  }

  failureLogOn(head: string, tree: string): FailedJobLog | null {
    return failedJobLog(args => this.gh.call(args, { cwd: tree }), head)
  }

  successfulRunsOnMain(limit: number): CiRead<RunOnMain[]> {
    return this.read<RunOnMain[]>(successfulRunsOnMainArgs(limit))
  }

  jobsOfRun(runId: number): CiRead<{ jobs: RunJob[] }> {
    return this.read<{ jobs: RunJob[] }>(jobsOfRunArgs(runId))
  }

  artifactsNamed(run: RunIdentity, name: string): CiRead<number> {
    const artifacts = this.read<{ total_count?: number }>(artifactsOfRunArgs(run, name))
    return artifacts.kind === 'failed' ? artifacts : { kind: 'read', value: artifacts.value.total_count ?? 0 }
  }

  downloadArtifact(runId: string | number, artifact: ArtifactRequest): CiAct {
    const downloaded = this.gh.call(artifactDownloadArgs(runId, artifact))
    return downloaded.kind === 'ran' ? { done: true } : { done: false, reason: downloaded.reason }
  }

  cancel(run: RunIdentity): boolean {
    return this.gh.call(runCancelArgs(run)).kind === 'ran'
  }
}

export interface CiWorld {
  commits?: Record<string, CheckRun[]>
  approvedHeads?: string[]
  rollups?: Record<number, RollupCheck[]>
  failedLogs?: Record<string, FailedJobLog>
  runsOnMain?: RunOnMain[]
  jobs?: Record<number, RunJob[]>
  artifacts?: Record<string, string[]>
}

export class InMemoryCi implements CiOfCommits, CiRuns {
  readonly cancelled: RunIdentity[] = []
  readonly downloaded: ArtifactRequest[] = []

  constructor(private readonly world: CiWorld = {}) {}

  onCommit(sha: string, requiredCheck = REQUIRED_CHECK): CommitCi {
    return commitCiOfRuns(this.world.commits?.[sha] ?? [], requiredCheck)
  }

  approvedRunOn(head: string | undefined): boolean {
    return head !== undefined && (this.world.approvedHeads ?? []).includes(head)
  }

  pullRequest(pr: PullRequest): PrDetails {
    return { ci: ciOfRollup(this.world.rollups?.[pr.number] ?? [], shortHead(pr.headRefOid)), files: [] }
  }

  failureLogOn(head: string): FailedJobLog | null {
    return this.world.failedLogs?.[head] ?? null
  }

  successfulRunsOnMain(limit: number): CiRead<RunOnMain[]> {
    return { kind: 'read', value: (this.world.runsOnMain ?? []).slice(0, limit) }
  }

  jobsOfRun(runId: number): CiRead<{ jobs: RunJob[] }> {
    return { kind: 'read', value: { jobs: this.world.jobs?.[runId] ?? [] } }
  }

  artifactsNamed(run: RunIdentity, name: string): CiRead<number> {
    return { kind: 'read', value: (this.world.artifacts?.[run.runId] ?? []).filter(artifact => artifact === name).length }
  }

  downloadArtifact(runId: string | number, artifact: ArtifactRequest): CiAct {
    if (!(this.world.artifacts?.[String(runId)] ?? []).includes(artifact.name))
      return { done: false, reason: `no artifact ${artifact.name} on run ${runId}` }
    this.downloaded.push(artifact)
    return { done: true }
  }

  cancel(run: RunIdentity): boolean {
    this.cancelled.push(run)
    return true
  }
}
