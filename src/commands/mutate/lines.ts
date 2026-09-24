export const TEST_PATH_SEPARATOR = ' › '
const FIELD_SEPARATOR = '|'
const REPLACEMENT_ARROW = '→'
const GREEN_PREDICTION = 'green'

export type Prediction = { kind: 'green' } | { kind: 'test', file: string, titles: string[] }

export interface FindReplace {
  kind: 'find'
  find: string
  replace: string
}

export interface ProseEdit {
  kind: 'edit'
  prose: string
}

export interface MutationLine {
  id: string
  file: string
  change: FindReplace | ProseEdit
  prediction: Prediction
  message: string | null
}

export type ParsedLine = { id: string, line: MutationLine } | { id: string, malformed: string }

interface Cursor {
  text: string
  at: number
}

function backtickRun(text: string, at: number): number {
  let end = at
  while (text[end] === '`')
    end += 1
  return end - at
}

function literalAt(cursor: Cursor): string | null {
  const width = backtickRun(cursor.text, cursor.at)
  if (width === 0)
    return null
  const fence = '`'.repeat(width)
  let search = cursor.at + width
  while (search <= cursor.text.length) {
    const close = cursor.text.indexOf(fence, search)
    if (close === -1)
      return null
    if (backtickRun(cursor.text, close) === width) {
      const value = cursor.text.slice(cursor.at + width, close)
      cursor.at = close + width
      return value
    }
    search = close + backtickRun(cursor.text, close)
  }
  return null
}

function splitFields(text: string): string[] | null {
  const fields: string[] = []
  const cursor: Cursor = { text, at: 0 }
  let start = 0
  while (cursor.at < text.length) {
    if (text[cursor.at] === '`') {
      if (literalAt(cursor) == null)
        return null
      continue
    }
    if (text[cursor.at] === FIELD_SEPARATOR) {
      fields.push(text.slice(start, cursor.at).trim())
      start = cursor.at + 1
    }
    cursor.at += 1
  }
  fields.push(text.slice(start).trim())
  return fields
}

function skipSpaces(cursor: Cursor): void {
  while (cursor.text[cursor.at] === ' ')
    cursor.at += 1
}

function findReplace(field: string): FindReplace | null {
  const cursor: Cursor = { text: field, at: 'find:'.length }
  skipSpaces(cursor)
  const find = literalAt(cursor)
  skipSpaces(cursor)
  if (find == null || !cursor.text.startsWith(REPLACEMENT_ARROW, cursor.at))
    return null
  cursor.at += REPLACEMENT_ARROW.length
  skipSpaces(cursor)
  const replace = literalAt(cursor)
  skipSpaces(cursor)
  if (replace == null || cursor.at !== cursor.text.length)
    return null
  return { kind: 'find', find, replace }
}

function change(field: string): FindReplace | ProseEdit | string {
  if (field.startsWith('edit:'))
    return { kind: 'edit', prose: field.slice('edit:'.length).trim() }
  if (!field.startsWith('find:'))
    return 'the third field is neither `find: `old` → `new`` nor `edit: <prose>`'
  return findReplace(field) ?? 'the find field is not `find: `old` → `new``'
}

function prediction(field: string): Prediction | string {
  if (!field.startsWith('red:'))
    return 'the fourth field does not start with `red:`'
  const named = field.slice('red:'.length).trim()
  if (named === GREEN_PREDICTION)
    return { kind: 'green' }
  const [file, ...titles] = named.split(TEST_PATH_SEPARATOR).map(part => part.trim())
  if (file === '' || titles.length === 0 || titles.includes(''))
    return `the red field names no test as <file>${TEST_PATH_SEPARATOR}<title>, and is not \`green\``
  return { kind: 'test', file, titles }
}

function message(field: string | undefined): string | null {
  if (field == null || field === '')
    return null
  const cursor: Cursor = { text: field, at: 0 }
  const literal = literalAt(cursor)
  return literal != null && cursor.at === field.length ? literal : field
}

export function parseMutationLine(text: string): ParsedLine {
  const fields = splitFields(text)
  const id = (fields?.[0] ?? text.split(FIELD_SEPARATOR)[0]).trim()
  if (fields == null)
    return { id, malformed: 'a backtick literal is not closed' }
  if (fields.length < 4 || fields.length > 5)
    return { id, malformed: `the line has ${fields.length} fields, not four or five` }
  if (fields[1] === '')
    return { id, malformed: 'the second field names no file' }
  const parsedChange = change(fields[2])
  if (typeof parsedChange === 'string')
    return { id, malformed: parsedChange }
  const parsedPrediction = prediction(fields[3])
  if (typeof parsedPrediction === 'string')
    return { id, malformed: parsedPrediction }
  return { id, line: { id, file: fields[1], change: parsedChange, prediction: parsedPrediction, message: message(fields[4]) } }
}

export function parseMutationFile(text: string): ParsedLine[] {
  return text.split(/\r?\n/).filter(line => line.startsWith('M')).map(parseMutationLine)
}
