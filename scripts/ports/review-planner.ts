import { execFile } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const REVIEW_PLAN_FLAG = '--plan'
export const REVIEW_PLANNER_SCRIPT = fileURLToPath(new URL('../nodes/review/review-planner-worker.ts', import.meta.url))
export const PLANNER_ARGUMENTS: readonly string[] = Object.freeze(['--import', 'tsx', REVIEW_PLANNER_SCRIPT, REVIEW_PLAN_FLAG])
const PLAN_OUTPUT_LIMIT = 1 << 26

export function plannerProcess(cwd: string, request: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [...PLANNER_ARGUMENTS], { cwd, encoding: 'utf8', maxBuffer: PLAN_OUTPUT_LIMIT, signal, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(request)
  })
}
