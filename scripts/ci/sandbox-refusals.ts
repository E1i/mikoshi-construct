export const REFUSALS = {
  'listen EPERM on the tsx IPC pipe': /listen EPERM: operation not permitted \S*tsx-\d+\/\d+\.pipe/,
  'spawnSync ps EPERM': /spawnSync ps EPERM/,
  'exec /bin/ps from a shell: Operation not permitted': /\/bin\/ps: Operation not permitted/,
  'mkdtemp under /tmp EPERM': /EPERM: operation not permitted, mkdtemp '\/tmp\//,
  'open under ~/.npm/_cacache EPERM': /npm error code EPERM\s+npm error syscall open\s+npm error path \S*\/\.npm\/_cacache\//,
} as const satisfies Record<string, RegExp>

export type Refusal = keyof typeof REFUSALS

export const SANDBOX_TRACE_VARIABLE = 'SANDBOX_TRACE'

export interface TraceLine { file: string, test: string, refused: string }

export function refusalsIn(text: string): Refusal[] {
  return (Object.keys(REFUSALS) as Refusal[]).filter(refusal => REFUSALS[refusal].test(text))
}
