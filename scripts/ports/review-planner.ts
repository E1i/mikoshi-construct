import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const REVIEW_PLAN_FLAG = '--plan'
const SOURCE_MODULE = /\.ts$/
const BUILT_MODULE = '.js'
const RUNS_FROM_THE_BUILD = !SOURCE_MODULE.test(fileURLToPath(import.meta.url))
const PLANNER_SOURCE = fileURLToPath(new URL('../nodes/review/review-planner-worker.ts', import.meta.url))
const SOURCE_LOADER = ['--import', 'tsx']
export const REVIEW_PLANNER_SCRIPT = RUNS_FROM_THE_BUILD ? PLANNER_SOURCE.replace(SOURCE_MODULE, BUILT_MODULE) : PLANNER_SOURCE
export const PLANNER_ARGUMENTS: readonly string[] = Object.freeze([...(RUNS_FROM_THE_BUILD ? [] : SOURCE_LOADER), REVIEW_PLANNER_SCRIPT, REVIEW_PLAN_FLAG])
const PLAN_OUTPUT_LIMIT = 1 << 26

export function plannerProcess(cwd: string, request: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const overflow = new AbortController()
    const child = spawn(process.execPath, [...PLANNER_ARGUMENTS], { cwd, signal: AbortSignal.any([signal, overflow.signal]), killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let size = 0
    const counted = (chunk: string): string => {
      size += Buffer.byteLength(chunk)
      if (size > PLAN_OUTPUT_LIMIT)
        overflow.abort(new Error(`the planning output passed ${PLAN_OUTPUT_LIMIT} bytes`))
      return chunk
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += counted(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += counted(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, endedBy) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`the planning process ended with ${code ?? endedBy}: ${stderr}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(request)
  })
}
