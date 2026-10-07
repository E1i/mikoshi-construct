import type { AttachRecord } from '../attach/record.js'
import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ATTACH_RUNTIME_BROWSER, ATTACH_RUNTIME_FILES, ATTACH_RUNTIME_RUN_DIRECTORY, ATTACH_RUNTIME_SHOT_SUFFIX } from '../attach/carriers.js'

export interface RunListing {
  name: string
  directory: boolean
  entries: { name: string, regular: boolean }[]
}

export interface RuntimeListing {
  regularFiles: string[]
  browser: 'absent' | 'directory' | 'other'
  runs: RunListing[]
}

export interface RuntimeRemoval {
  files: string[]
  runs: { directory: string, shots: string[] }[]
  browser: boolean
}

function kindOf(absolute: string): 'absent' | 'file' | 'directory' | 'other' {
  try {
    const stat = lstatSync(absolute)
    if (stat.isFile())
      return 'file'
    return stat.isDirectory() ? 'directory' : 'other'
  }
  catch {
    return 'absent'
  }
}

function listRun(root: string, name: string): RunListing {
  const absolute = path.join(root, ATTACH_RUNTIME_BROWSER, name)
  if (kindOf(absolute) !== 'directory')
    return { name, directory: false, entries: [] }
  const entries = readdirSync(absolute).map(entry => ({ name: entry, regular: kindOf(path.join(absolute, entry)) === 'file' }))
  return { name, directory: true, entries }
}

export function readRuntimeListing(root: string): RuntimeListing {
  const browser = kindOf(path.join(root, ATTACH_RUNTIME_BROWSER))
  return {
    regularFiles: ATTACH_RUNTIME_FILES.filter(target => kindOf(path.join(root, target)) === 'file'),
    browser: browser === 'absent' || browser === 'directory' ? browser : 'other',
    runs: browser === 'directory' ? readdirSync(path.join(root, ATTACH_RUNTIME_BROWSER)).map(name => listRun(root, name)) : [],
  }
}

function heldAtAttach(record: AttachRecord): (target: string) => boolean {
  const held: unknown = record.ledgerHeld
  if (held === undefined)
    return () => record.ledgerCreated !== true
  if (Array.isArray(held) && held.every(target => typeof target === 'string'))
    return target => held.includes(target)
  return () => true
}

function isShot(entry: { name: string, regular: boolean }): boolean {
  return entry.regular && entry.name.endsWith(ATTACH_RUNTIME_SHOT_SUFFIX)
}

export function classifyRuntime(record: AttachRecord, tracked: Set<string>, listing: RuntimeListing): RuntimeRemoval {
  const held = heldAtAttach(record)
  const files = listing.regularFiles.filter(target => !tracked.has(target) && !held(target))
  const browserFree = listing.browser === 'directory' && !held(ATTACH_RUNTIME_BROWSER)
  const runs = browserFree
    ? listing.runs.filter(run => ATTACH_RUNTIME_RUN_DIRECTORY.test(run.name) && run.directory && run.entries.every(isShot) && run.entries.every(entry => !tracked.has(`${ATTACH_RUNTIME_BROWSER}/${run.name}/${entry.name}`)))
    : []
  return {
    files,
    runs: runs.map(run => ({ directory: `${ATTACH_RUNTIME_BROWSER}/${run.name}`, shots: run.entries.map(entry => `${ATTACH_RUNTIME_BROWSER}/${run.name}/${entry.name}`) })),
    browser: browserFree,
  }
}
