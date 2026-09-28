import { Buffer } from 'node:buffer'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

const TAIL_BYTES = 262_144

export function reportAgeSeconds(reportPath: string): number | null {
  if (!existsSync(reportPath))
    return null
  const stat = statSync(reportPath)
  return Math.trunc((Date.now() - stat.mtimeMs) / 1000)
}

export function reportAgeField(reportPath: string): string {
  const age = reportAgeSeconds(reportPath)
  if (age === null)
    return 'no report'
  return age < 0 ? 'report in the future' : `report ${age}s`
}

function readTail(reportPath: string): string | null {
  if (!existsSync(reportPath))
    return null
  const size = statSync(reportPath).size
  const length = Math.min(size, TAIL_BYTES)
  const start = size - length
  const fd = openSync(reportPath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  }
  finally {
    closeSync(fd)
  }
}

interface ContentItem {
  type?: string
  name?: string
}

interface ReportLine {
  type?: string
  message?: {
    role?: string
    content?: ContentItem[]
  }
}

export function lastToolName(reportPath: string): string | null {
  const tail = readTail(reportPath)
  if (tail === null)
    return null

  let lastTool: string | null = null
  for (const line of tail.split('\n')) {
    if (line.trim() === '')
      continue
    let parsed: ReportLine
    try {
      parsed = JSON.parse(line) as ReportLine
    }
    catch {
      continue
    }
    if (parsed.type !== 'assistant' || !Array.isArray(parsed.message?.content))
      continue
    for (const item of parsed.message.content) {
      if (item.type === 'tool_use' && typeof item.name === 'string')
        lastTool = item.name
    }
  }
  return lastTool
}
