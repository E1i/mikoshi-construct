import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { canonicalImplementText, sha256Hex } from './approval.js'

export function hashBrief(briefPath: string): string {
  const content = readFileSync(briefPath, 'utf8')
  const text = canonicalImplementText(content)
  if (text === undefined)
    throw new Error(`${briefPath}: no line starting with '/implement ' in the brief`)
  return sha256Hex(text)
}

async function main(): Promise<void> {
  const briefPath = process.argv[2]
  if (briefPath === undefined) {
    console.error('usage: hash.ts <brief>')
    process.exitCode = 1
    return
  }

  try {
    console.log(hashBrief(briefPath))
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main()
