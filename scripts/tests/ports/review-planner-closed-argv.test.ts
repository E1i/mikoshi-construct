import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as { program: string, args: readonly string[], cwd: unknown, signal: unknown, killSignal: unknown, input: string }[])

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (program: string, args: readonly string[], options: { cwd?: unknown, signal?: unknown, killSignal?: unknown }, done: (error: Error | null, stdout: string) => void) => {
      const call = { program, args, cwd: options.cwd, signal: options.signal, killSignal: options.killSignal, input: '' }
      spawned.push(call)
      queueMicrotask(() => done(null, '{"depth":"full","why":"fake","prediction":null}\n'))
      return {
        stdin: {
          on: () => {},
          end: (text: string) => {
            call.input = text
          },
        },
      }
    },
  }
})

const { PLANNER_ARGUMENTS, plannerProcess, REVIEW_PLAN_FLAG, REVIEW_WORKER_SCRIPT } = await import('../../ports/review-planner.js')
const worker = await import('../../nodes/review/review-worker.js')

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORKER_SOURCE = path.join(REPO_ROOT, 'scripts', 'nodes', 'review', 'review-worker.ts')
const inheritedExecArgv = process.execArgv

afterEach(() => {
  spawned.length = 0
  Object.defineProperty(process, 'execArgv', { value: inheritedExecArgv, configurable: true, writable: true })
})

describe('the review planner port', () => {
  it('the review planner spawns a fixed binary with a closed argument list and takes no caller command', async () => {
    Object.defineProperty(process, 'execArgv', { value: ['--inspect', '--require', '/elsewhere/hook.js'], configurable: true, writable: true })
    const lease = { taskKey: 'review:1832:1732:x', queue: 'review' as const, cardId: 1832, pr: 1732, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:review:w' }

    const plan = await worker.childReviewPlanner(REPO_ROOT)(lease, null, new AbortController().signal)

    expect(plan).toEqual({ depth: 'full', why: 'fake', prediction: null })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.program).toBe(process.execPath)
    expect(spawned[0]!.args).toEqual(['--import', 'tsx', REVIEW_WORKER_SCRIPT, REVIEW_PLAN_FLAG])
    expect(spawned[0]!.args).toEqual(PLANNER_ARGUMENTS)
    expect(REVIEW_WORKER_SCRIPT).toBe(WORKER_SOURCE)
    expect(spawned[0]!.cwd).toBe(REPO_ROOT)
    expect(JSON.parse(spawned[0]!.input)).toEqual({ lease, earlier: null })
    expect(Object.isFrozen(PLANNER_ARGUMENTS)).toBe(true)
    expect(plannerProcess).toHaveLength(3)
    expect(worker.childReviewPlanner).toHaveLength(1)
    expect(readFileSync(WORKER_SOURCE, 'utf8')).not.toMatch(/node:child_process/)
  })

  it('the planning child is stopped by the lease\'s abort signal with SIGKILL, so a child that ignores SIGTERM still ends at the limit', async () => {
    const lease = { taskKey: 'review:1832:1732:x', queue: 'review' as const, cardId: 1832, pr: 1732, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:review:w' }
    const abort = new AbortController()

    await worker.childReviewPlanner(REPO_ROOT)(lease, null, abort.signal)

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.signal).toBe(abort.signal)
    expect(spawned[0]!.killSignal).toBe('SIGKILL')
  })
})
