export interface TaskMustWait {
  readonly message: string
  readonly retryAfterSeconds: number
  readonly taskMustWait: true
}

const RETRY_AFTER_IN_THE_MESSAGE = /retry after (\d+) s/

export function mustWait(error: unknown): error is TaskMustWait {
  return error instanceof Error
    && 'taskMustWait' in error && error.taskMustWait === true
    && 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
}

export function retryAfterSecondsIn(message: string): number | null {
  const match = RETRY_AFTER_IN_THE_MESSAGE.exec(message)
  return match === null ? null : Number(match[1])
}
