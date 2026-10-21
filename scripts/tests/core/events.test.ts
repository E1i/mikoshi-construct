import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as events from '../../core/events.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const CORE_EVENTS = 'scripts/core/events.ts'
const STRING_CONSTANT = /^(?:export )?const (\w+)(?::[^=]+)? = '([^']*)'/gm

const eventNames = Object.entries(events as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].endsWith('_LANE'))

function sourceFiles(): string[] {
  const files = ['scripts', 'src'].flatMap(root => readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: 'utf8' }).map(file => path.posix.join(root, file.split(path.sep).join('/'))))
  return files.filter(file => file.endsWith('.ts') && !file.startsWith('scripts/tests/') && file !== CORE_EVENTS)
}

function definitionsOutsideCore(): string[] {
  const names = new Set(eventNames.map(([name]) => name))
  const dottedValues = new Set(eventNames.map(([, value]) => value).filter(value => value.includes('.')))
  return sourceFiles().flatMap(file => [...readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(STRING_CONSTANT)]
    .filter(([, name, value]) => names.has(name) || dottedValues.has(value))
    .map(([, name, value]) => `${file}: ${name} = '${value}'`))
}

describe('the bus event vocabulary', () => {
  it('every bus event name is defined once, in core/events', () => {
    const values = eventNames.map(([, value]) => value)
    expect(values.filter((value, index) => values.indexOf(value) !== index)).toEqual([])
    expect(eventNames.map(([name]) => name)).toEqual(expect.arrayContaining(['CARD_ADMITTED', 'CARD_VERIFIED', 'CARD_CLOSED', 'PR_CLOSED', 'CARD_WAITING', 'INTAKE_EVENT', 'INTAKE_MOVE_EVENT']))
    expect(definitionsOutsideCore()).toEqual([])
  })
})
