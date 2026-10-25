import { spawnSync } from 'node:child_process'

export interface Regenerated {
  path: string
  check: readonly string[]
}

export const REGENERATED: readonly Regenerated[] = [
  { path: 'templates/attach/earlier-carriers.json', check: ['exec', 'tsx', 'scripts/attach/earlier-carriers.ts', '--check'] },
]

export const REGENERATED_PATHS = REGENERATED.map(entry => entry.path)

export interface CheckResult { status: number | null, stderr: string }
export type CheckRunner = (cwd: string, args: readonly string[]) => CheckResult

export function pnpmCheck(cwd: string, args: readonly string[]): CheckResult {
  const result = spawnSync('pnpm', [...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stderr: result.error?.message ?? result.stderr }
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? 'no error printed'
}

export function regeneratedCheckFailures(cwd: string, paths: readonly string[], run: CheckRunner = pnpmCheck): string[] {
  return REGENERATED.filter(entry => paths.includes(entry.path)).flatMap((entry) => {
    const result = run(cwd, entry.check)
    return result.status === 0 ? [] : [`${entry.path}: pnpm ${entry.check.join(' ')} exited ${result.status ?? 'without a status'}: ${firstLine(result.stderr)}`]
  })
}

export function regeneratedCheckFailedOutcome(failures: readonly string[]): string {
  return `regenerated check failed, no session: ${failures.join('; ')}; regenerate on the sketch or re-approve the brief`
}

export function approvalCarryEvent(task: string, approvedSketch: string, sketch: string | null, regenerated: readonly string[], now: Date): object {
  return { event: 'approval-carry', ts: now.toISOString(), task, kind: 'regenerated', approvedSketch, sketch, regenerated: [...regenerated] }
}
