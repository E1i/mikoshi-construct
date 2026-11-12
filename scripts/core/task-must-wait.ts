export class TaskMustWait extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message)
  }
}
