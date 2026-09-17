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

export function describeOutcome(outcome: RegistryOutcome, request: RegistryRequest): string {
  const specifier = `${request.packageName}@${request.version}`

  if (outcome === 'installable')
    return `${specifier} is on the registry and installable.`

  if (outcome === 'absent') {
    return [
      `${specifier} is not on the registry.`,
      'Either the publish is staged and awaiting approval, or it failed while reporting success.',
      'Approve the staged version on npmjs.com or with `npm stage approve`, then re-run the Release verification workflow.',
    ].join(' ')
  }

  return `The registry could not be asked about ${specifier}. Unknown is not absent — nothing is claimed about the published state.`
}
