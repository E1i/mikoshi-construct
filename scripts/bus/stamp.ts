import { Buffer } from 'node:buffer'
import process from 'node:process'

export const STAMP_ENV = 'BUS_LOG_STAMP'

export class LineStamper {
  private atLineStart = true
  private readonly now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  stamp(chunk: string): string {
    if (chunk === '')
      return ''
    const prefix = this.atLineStart ? this.mark() : ''
    this.atLineStart = chunk.endsWith('\n')
    const body = this.atLineStart ? chunk.slice(0, -1) : chunk
    return `${prefix}${body.replaceAll('\n', `\n${this.mark()}`)}${this.atLineStart ? '\n' : ''}`
  }

  private mark(): string {
    return `${this.now().toISOString()} `
  }
}

function isText(encoding: unknown): boolean {
  return typeof encoding !== 'string' || encoding === 'utf8' || encoding === 'utf-8'
}

export function stampStream(stream: NodeJS.WritableStream, stamper: LineStamper = new LineStamper()): void {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!isText(rest[0]))
      return write(chunk, ...rest)
    if (typeof chunk === 'string')
      return write(stamper.stamp(chunk), ...rest)
    if (chunk instanceof Uint8Array)
      return write(stamper.stamp(Buffer.from(chunk).toString('utf8')), ...rest)
    return write(chunk, ...rest)
  }) as typeof stream.write
}

export function stampLogOutput(env: NodeJS.ProcessEnv = process.env): void {
  if (env[STAMP_ENV] !== '1')
    return
  delete env[STAMP_ENV]
  stampStream(process.stdout)
  stampStream(process.stderr)
}
