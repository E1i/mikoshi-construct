export interface TaskMustWait {
  readonly message: string
  readonly retryAfterSeconds: number
  readonly taskMustWait: true
}

export function mustWait(error: unknown): error is TaskMustWait {
  return error instanceof Error
    && 'taskMustWait' in error && error.taskMustWait === true
    && 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
}
