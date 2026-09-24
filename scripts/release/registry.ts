import type { ReleaseRouteReading } from './changesets.js'
import type { StageRecord } from './stage.js'

export type RegistryOutcome = 'installable' | 'propagating' | 'absent' | 'unreachable'

export type VerificationOutcome = RegistryOutcome | 'staged'

export interface RegistryRequest {
  packageName: string
  version: string
}

export interface RegistryFetchers {
  metadata: (request: RegistryRequest) => Promise<Response>
  tarball: (url: string) => Promise<Response>
}

export type Sleep = (milliseconds: number) => Promise<void>

export interface PollOptions {
  fetchers: RegistryFetchers
  now: () => number
  sleep: Sleep
  timeoutMs: number
  delayMs: number
}

export const EXIT_CODE: Record<VerificationOutcome, number> = {
  installable: 0,
  absent: 1,
  unreachable: 2,
  propagating: 3,
  staged: 4,
}

async function fetchMetadata(request: RegistryRequest): Promise<Response> {
  const specifier = `${encodeURIComponent(request.packageName).replace('%40', '@')}/${encodeURIComponent(request.version)}`
  return fetch(`https://registry.npmjs.org/${specifier}`, { headers: { accept: 'application/json' } })
}

async function fetchTarball(url: string): Promise<Response> {
  return fetch(url, { method: 'HEAD' })
}

export const REGISTRY: RegistryFetchers = { metadata: fetchMetadata, tarball: fetchTarball }

interface ServedVersion {
  version?: unknown
  dist?: { tarball?: unknown }
}

async function servedMetadata(request: RegistryRequest, fetchers: RegistryFetchers): Promise<ServedVersion | RegistryOutcome> {
  let response: Response
  try {
    response = await fetchers.metadata(request)
  }
  catch {
    return 'unreachable'
  }
  if (response.status === 404)
    return 'absent'
  if (!response.ok)
    return 'unreachable'
  try {
    return (await response.json() as ServedVersion | null) ?? 'absent'
  }
  catch {
    return 'unreachable'
  }
}

async function tarballOutcome(url: string, fetchers: RegistryFetchers): Promise<RegistryOutcome> {
  let response: Response
  try {
    response = await fetchers.tarball(url)
  }
  catch {
    return 'unreachable'
  }
  if (response.status === 404)
    return 'propagating'
  return response.ok ? 'installable' : 'unreachable'
}

export async function checkVersion(request: RegistryRequest, fetchers: RegistryFetchers): Promise<RegistryOutcome> {
  const served = await servedMetadata(request, fetchers)
  if (typeof served === 'string')
    return served
  if (served.version !== request.version)
    return 'absent'
  const tarball = served.dist?.tarball
  if (typeof tarball !== 'string' || tarball === '')
    return 'unreachable'
  return tarballOutcome(tarball, fetchers)
}

export async function pollForVersion(request: RegistryRequest, options: PollOptions): Promise<RegistryOutcome> {
  const deadline = options.now() + options.timeoutMs
  for (;;) {
    const outcome = await checkVersion(request, options.fetchers)
    if (outcome === 'installable' || options.now() + options.delayMs > deadline)
      return outcome
    await options.sleep(options.delayMs)
  }
}

export function withStage(outcome: RegistryOutcome, stage: StageRecord | undefined): VerificationOutcome {
  return outcome === 'absent' && stage !== undefined ? 'staged' : outcome
}

export function describeStaged(stage: StageRecord, packageName: string): string {
  return [
    `${packageName}@${stage.version} is not on the registry yet because the Release run staged it as ${stage.stageId}, and a staged version waits for a human to approve it.`,
    'This is pending, not a failure.',
    `Approve stage ${stage.stageId} (npm stage approve ${stage.stageId}), then re-run this run after approval.`,
  ].join(' ')
}

function pendingEvidence(reading: ReleaseRouteReading): string {
  const counted = reading.pending.length === 1
    ? '1 unconsumed changeset is'
    : `${reading.pending.length} unconsumed changesets are`
  return `${counted} still in ${reading.dir}/ (${reading.pending.join(', ')})`
}

const TELLS_THEM_APART = 'The repair differs between them, and the Release run\'s log is what tells them apart.'

function describeAbsent(specifier: string, reading: ReleaseRouteReading): string {
  if (reading.route === 'versioning') {
    return [
      `${specifier} is not on the registry, and the release workflow did not publish it.`,
      `${pendingEvidence(reading)}, and on a tree carrying one the release action versions instead of publishing.`,
      'Merge the version pull request it opened or updated; the release that runs on that merge publishes this work under the version the pull request writes.',
    ].join(' ')
  }

  if (reading.route === 'publishing') {
    return [
      `${specifier} is not on the registry, and nothing is pending in ${reading.dir}/, so the release action took the publishing route.`,
      'Two states are left: the publish is staged and awaiting approval, or it failed while reporting success.',
      TELLS_THEM_APART,
    ].join(' ')
  }

  return [
    `${specifier} is not on the registry, and three states produce that same answer:`,
    'the publish is staged and awaiting approval, it failed while reporting success,',
    'or it never ran because the release action was versioning instead.',
    `${reading.dir}/ could not be read here, so which of them this is has not been determined.`,
    TELLS_THEM_APART,
  ].join(' ')
}

export function describeOutcome(outcome: RegistryOutcome, request: RegistryRequest, reading: ReleaseRouteReading): string {
  const specifier = `${request.packageName}@${request.version}`

  if (outcome === 'installable')
    return `${specifier} is on the registry and installable.`

  if (outcome === 'absent')
    return describeAbsent(specifier, reading)

  if (outcome === 'propagating') {
    return [
      `${specifier} is published: the registry serves its metadata, but its tarball still answers 404, so it has not reached the CDN yet.`,
      'Nothing needs to be published again. Re-run this verification in a few minutes.',
    ].join(' ')
  }

  return `The registry could not be asked about ${specifier}. Unknown is not absent — nothing is claimed about the published state.`
}
