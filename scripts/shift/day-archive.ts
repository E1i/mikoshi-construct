import { Buffer } from 'node:buffer'
import path from 'node:path'
import { DECISIONS_IN_FORCE_LIMIT } from '../decisions/decisions.js'

export const DAY_FILE_LIMIT = DECISIONS_IN_FORCE_LIMIT
export const QUESTIONS_HEADING = '## Owner questions'

const DAY_FILE_NAME = /(?:~\/|\/)?[\w./-]*?day-\d{4}-\d{2}-\d{2}\.md\b/
const SECTION_HEADING = /^## /
const TITLE = /^# /
const QUESTION_ITEM = /^- Q\d+ /
const OPEN_QUESTION = /^- Q\d+ open\b/
const OWNER_TEXT_HEADING = /^## Owner\b/i
const SESSION_IN_HEADING = /\bsession (\d+)\b/i

export interface DaySplit {
  kept: string
  moved: string
}

function sectionsOf(lines: readonly string[]): { preamble: string[], sections: string[][] } {
  const first = lines.findIndex(line => SECTION_HEADING.test(line))
  const preamble = first === -1 ? [...lines] : lines.slice(0, first)
  const sections: string[][] = []
  for (const line of first === -1 ? [] : lines.slice(first)) {
    if (SECTION_HEADING.test(line))
      sections.push([line])
    else
      sections.at(-1)!.push(line)
  }
  return { preamble, sections }
}

function questionItems(body: readonly string[]): { lead: string[], items: string[][] } {
  const lead: string[] = []
  const items: string[][] = []
  for (const line of body) {
    if (QUESTION_ITEM.test(line))
      items.push([line])
    else if (items.length === 0)
      lead.push(line)
    else
      items.at(-1)!.push(line)
  }
  return { lead, items }
}

function ownerTextOfSession(heading: string, session: string): boolean {
  return OWNER_TEXT_HEADING.test(heading) && SESSION_IN_HEADING.exec(heading)?.[1] === session
}

function joined(blocks: readonly string[][]): string {
  const text = blocks.map(block => block.join('\n').trimEnd()).filter(block => block !== '').join('\n\n')
  return text === '' ? '' : `${text}\n`
}

export function splitDay(text: string, session: string): DaySplit {
  const { preamble, sections } = sectionsOf(text.split(/\r?\n/))
  const titleAt = preamble.findIndex(line => line.trim() !== '')
  const hasTitle = titleAt !== -1 && TITLE.test(preamble[titleAt]!)
  const kept: string[][] = [hasTitle ? [preamble[titleAt]!] : []]
  const moved: string[][] = [hasTitle ? preamble.slice(titleAt + 1) : preamble]
  for (const [heading, ...body] of sections) {
    if (heading === QUESTIONS_HEADING) {
      const { lead, items } = questionItems(body)
      const open = items.filter(item => OPEN_QUESTION.test(item[0]!))
      const answered = items.filter(item => !OPEN_QUESTION.test(item[0]!))
      kept.push([heading, ...lead, ...open.flat()])
      if (answered.length > 0)
        moved.push([heading, '', ...answered.flat()])
    }
    else if (ownerTextOfSession(heading!, session)) {
      kept.push([heading!, ...body])
    }
    else {
      moved.push([heading!, ...body])
    }
  }
  return { kept: joined(kept), moved: joined(moved) }
}

export function dayBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function dayFileNamedIn(draft: string, home: string, base: string): string | null {
  const named = DAY_FILE_NAME.exec(draft)?.[0]
  if (named === undefined)
    return null
  return named.startsWith('~/') ? path.join(home, named.slice(2)) : path.resolve(base, named)
}

export function archiveOfDay(dayFile: string): string {
  return dayFile.replace(/\.md$/, '.archive.md')
}

export function appended(archive: string, moved: string): string {
  return archive === '' ? moved : `${archive.replace(/\n*$/, '\n')}\n${moved}`
}
