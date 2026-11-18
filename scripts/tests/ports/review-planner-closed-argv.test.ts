import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as { program: string, args: readonly string[], cwd: unknown, signal: unknown, killSignal: unknown, input: string, kills: unknown[] }[])
const child = vi.hoisted(() => ({ runsUntilKilled: false }))

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    spawn: (program: string, args: readonly string[], options: { cwd?: unknown, signal?: AbortSignal, killSignal?: unknown }) => {
      const call = { program, args, cwd: options.cwd, signal: options.signal, killSignal: options.killSignal, input: '', kills: [] as unknown[] }
      spawned.push(call)
      const planning = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
        stdin: {
          on: () => {},
          end: (text: string) => {
            call.input = text
          },
        },
      })
      let ended = false
      const end = (code: number | null, signal: unknown): void => {
        if (ended)
          return
        ended = true
        planning.emit('close', code, signal)
      }
      const killedByAbort = (): void => {
        if (ended)
          return
        call.kills.push(options.killSignal ?? 'SIGTERM')
        planning.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        end(null, options.killSignal ?? 'SIGTERM')
      }
      if (options.signal?.aborted)
        queueMicrotask(killedByAbort)
      else
        options.signal?.addEventListener('abort', killedByAbort, { once: true })
      if (!child.runsUntilKilled) {
        queueMicrotask(() => {
          planning.stdout.emit('data', '{"depth":"full","why":"fake","prediction":null}\n')
          end(0, null)
        })
      }
      return planning
    },
  }
})

const { PLANNER_ARGUMENTS, plannerProcess, REVIEW_PLAN_FLAG, REVIEW_PLANNER_SCRIPT } = await import('../../ports/review-planner.js')
const worker = await import('../../nodes/review/review-worker.js')

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORKER_SOURCE = path.join(REPO_ROOT, 'scripts', 'nodes', 'review', 'review-worker.ts')
const PLANNER_ENTRY = path.join(REPO_ROOT, 'scripts', 'nodes', 'review', 'review-planner-worker.ts')
const inheritedExecArgv = process.execArgv

afterEach(() => {
  spawned.length = 0
  child.runsUntilKilled = false
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
    expect(spawned[0]!.args).toEqual(['--import', 'tsx', REVIEW_PLANNER_SCRIPT, REVIEW_PLAN_FLAG])
    expect(spawned[0]!.args).toEqual(PLANNER_ARGUMENTS)
    expect(REVIEW_PLANNER_SCRIPT).toBe(PLANNER_ENTRY)
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
    child.runsUntilKilled = true

    const planned = worker.childReviewPlanner(REPO_ROOT)(lease, null, abort.signal)
    const killsBeforeTheLimit = [...spawned[0]!.kills]
    abort.abort()

    await expect(planned).rejects.toThrow('aborted')
    expect(killsBeforeTheLimit).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.killSignal).toBe('SIGKILL')
    expect(spawned[0]!.kills).toEqual(['SIGKILL'])
  })

  it('a planning child whose lease was aborted before it spawned is killed with SIGKILL at once', async () => {
    const abort = new AbortController()
    abort.abort()
    child.runsUntilKilled = true

    await expect(plannerProcess(REPO_ROOT, '{}', abort.signal)).rejects.toThrow('aborted')
    expect(spawned[0]!.kills).toEqual(['SIGKILL'])
  })

  it('a planning child that ended is not killed by a later abort', async () => {
    const abort = new AbortController()

    await plannerProcess(REPO_ROOT, '{}', abort.signal)
    abort.abort()

    expect(spawned[0]!.kills).toEqual([])
  })
})
