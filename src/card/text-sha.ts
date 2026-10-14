import { createHash } from 'node:crypto'

export function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
