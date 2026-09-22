import type { ReleaseRouteReading } from './changesets.js'

export type RegistryOutcome = 'installable' | 'absent' | 'unreachable'

export interface RegistryRequest {
  packageName: string
  version: string
}

export type RegistryFetcher = (request: RegistryRequest) => Promise<Response>

export type Sleep = (milliseconds: number) => Promise<void>

export interface PollOptions {
  fetcher: RegistryFetcher
  sleep: Sleep
  attempts: number
  delayMs: number
}

export const EXIT_CODE: Record<RegistryOutcome, number> = {
  installable: 0,
  absent: 1,
  unreachable: 2,
}

export async function fetchFromRegistry(request: RegistryRequest): Promise<Response> {
  const specifier = `${encodeURIComponent(request.packageName).replace('%40', '@')}/${encodeURIComponent(request.version)}`
  return fetch(`https://registry.npmjs.org/${specifier}`, { headers: { accept: 'application/json' } })
}

export async function checkVersion(request: RegistryRequest, fetcher: RegistryFetcher): Promise<RegistryOutcome> {
  let response: Response
  try {
    response = await fetcher(request)
  }
  catch {
    return 'unreachable'
  }

  if (response.status === 404)
    return 'absent'

  if (!response.ok)
    return 'unreachable'

  let body: unknown
  try {
    body = await response.json()
  }
  catch {
    return 'unreachable'
  }

  const servedVersion = (body as { version?: unknown } | null)?.version
  return servedVersion === request.version ? 'installable' : 'absent'
}

export async function pollForVersion(request: RegistryRequest, options: PollOptions): Promise<RegistryOutcome> {
  let outcome: RegistryOutcome = 'unreachable'

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    outcome = await checkVersion(request, options.fetcher)

    if (outcome === 'installable')
      return outcome

    if (attempt < options.attempts)
      await options.sleep(options.delayMs)
  }

  return outcome
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

  return `The registry could not be asked about ${specifier}. Unknown is not absent — nothing is claimed about the published state.`
}
