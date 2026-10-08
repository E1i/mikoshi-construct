import type { ImportReader } from './reader.js'
import { tsJsReader } from './ts-js.js'

const EXTENSIONS = ['.vue', '.svelte', '.astro']
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
const LEADING_FENCE = /^(?:\s*\n)?---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/

function blankAllBut(source: string, kept: Array<[number, number]>): string {
  let result = source.replace(/[^\n]/g, ' ')
  for (const [start, end] of kept)
    result = `${result.slice(0, start)}${source.slice(start, end)}${result.slice(end)}`
  return result
}

export function scriptsOf(source: string): string {
  const kept: Array<[number, number]> = []
  const fence = LEADING_FENCE.exec(source)
  if (fence != null) {
    const start = fence.index + fence[0].indexOf(fence[1])
    kept.push([start, start + fence[1].length])
  }
  for (const match of source.matchAll(SCRIPT_BLOCK)) {
    const start = match.index + match[0].indexOf('>') + 1
    kept.push([start, start + match[1].length])
  }
  return blankAllBut(source, kept)
}

export const sfcScriptReader: ImportReader = {
  recognises: file => EXTENSIONS.some(extension => file.endsWith(extension)),
  read: source => tsJsReader.read(scriptsOf(source)),
}
