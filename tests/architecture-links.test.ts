import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const ARCHITECTURE = 'architecture'
const LINK_TARGET = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const FENCE = /^\s*(?:```|~~~)/
const INLINE_CODE = /`[^`]*`/g
const EXTERNAL = /^(?:https?:|mailto:)/

function markdownFiles(directory: string): string[] {
  return readdirSync(path.join(REPO_ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter(entry => entry.endsWith('.md'))
    .map(entry => path.join(directory, entry))
    .sort()
}

function localTarget(target: string): string | undefined {
  if (EXTERNAL.test(target) || target.startsWith('#'))
    return undefined
  return decodeURI(target.split('#')[0]!)
}

function brokenLinks(file: string): string[] {
  const broken: string[] = []
  let inFence = false
  readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence)
      return
    for (const [, target] of line.replace(INLINE_CODE, '').matchAll(LINK_TARGET)) {
      const local = localTarget(target!)
      if (local !== undefined && !existsSync(path.resolve(REPO_ROOT, path.dirname(file), local)))
        broken.push(`${file}:${index + 1} ${target}`)
    }
  })
  return broken
}

describe('relative links under architecture/', () => {
  it('every relative link target exists from the folder of the file that holds it', () => {
    expect(markdownFiles(ARCHITECTURE).flatMap(brokenLinks)).toEqual([])
  })
})
