import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type ApprovalCheck
  = | { ok: true, text: string }
    | { ok: false, reason: string }

export function extractImplementText(content: string): string | undefined {
  const index = content.search(/^\/implement /m)
  if (index === -1)
    return undefined
  return content.slice(index)
}

export function canonicalImplementText(content: string): string | undefined {
  const text = extractImplementText(content)
  if (text === undefined)
    return undefined
  return text.replace(/\n+$/, '')
}

export function implementLineNumbers(content: string): number[] {
  const numbers: number[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('/implement '))
      numbers.push(index + 1)
  }
  return numbers
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function approvedHashPath(briefPath: string): string {
  return `${briefPath.replace(/\.md$/, '')}.approved-sha256`
}

export function extractApprovedHash(content: string): string | undefined {
  const match = /sha256:\s*([0-9a-f]{64})/.exec(content)
  return match?.[1]
}

export function checkApproval(briefPath: string): ApprovalCheck {
  const content = readFileSync(briefPath, 'utf8')

  const lineNumbers = implementLineNumbers(content)
  if (lineNumbers.length > 1) {
    return {
      ok: false,
      reason: `${briefPath}: more than one line starts with '/implement ' (lines ${lineNumbers.join(', ')})`,
    }
  }

  const text = canonicalImplementText(content)
  if (text === undefined)
    return { ok: false, reason: `${briefPath}: no line starting with '/implement ' in the brief` }

  const approvedPath = approvedHashPath(briefPath)
  if (!existsSync(approvedPath))
    return { ok: false, reason: `${briefPath}: no approval file ${path.basename(approvedPath)} next to the brief` }

  const approvedContent = readFileSync(approvedPath, 'utf8')
  const expected = extractApprovedHash(approvedContent)
  if (expected === undefined)
    return { ok: false, reason: `${briefPath}: no approval hash in ${path.basename(approvedPath)}` }

  const actual = sha256Hex(text)
  if (actual !== expected) {
    return {
      ok: false,
      reason: `${briefPath}: the /implement text does not match the approved hash (approved ${expected}, actual ${actual})`,
    }
  }

  return { ok: true, text }
}
