export const CLOUD_VARIABLE = 'CONSTRUCT_CLOUD'

const CLOUD_ON = 'on'

export function cloudOn(env: Record<string, string | undefined>): boolean {
  return env[CLOUD_VARIABLE] === CLOUD_ON
}
