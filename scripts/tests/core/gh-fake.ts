import type { GhCall, GhCaller, GhRead } from '../../ports/gh.js'

export function ran(stdout: string): GhCall {
  return { kind: 'ran', stdout, attempts: 1 }
}

export function failed(reason: string): GhCall {
  return { kind: 'failed', cause: 'failed', reason, stdout: '', stderr: reason, attempts: 1 }
}

export function read<T>(value: T): GhRead<T> {
  return { kind: 'read', value }
}

export function unread(reason: string): GhRead<never> {
  return { kind: 'failed', reason, cause: 'failed' }
}

export function callerOf(answer: (args: string[]) => string): GhCaller {
  return (args) => {
    try {
      return ran(answer(args))
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  }
}
