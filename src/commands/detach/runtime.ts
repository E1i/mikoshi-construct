import type { AttachRecord } from '../attach/record.js'
import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ATTACH_RUNTIME_BROWSER, ATTACH_RUNTIME_DAEMON, ATTACH_RUNTIME_FILES, ATTACH_RUNTIME_RUN_DIRECTORY, ATTACH_RUNTIME_SHOT_SUFFIX } from '../attach/carriers.js'

export interface RunListing {
  name: string
  directory: boolean
  entries: { name: string, regular: boolean }[]
}

export interface DaemonRunListing {
  name: string
  directory: boolean
  objects: RunListing[]
}

export interface RuntimeListing {
  regularFiles: string[]
  browser: 'absent' | 'directory' | 'other'
  runs: RunListing[]
  daemon: 'absent' | 'directory' | 'other'
  daemonRuns: DaemonRunListing[]
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

function listRun(root: string, parent: string, name: string): RunListing {
  const absolute = path.join(root, parent, name)
  if (kindOf(absolute) !== 'directory')
    return { name, directory: false, entries: [] }
  const entries = readdirSync(absolute).map(entry => ({ name: entry, regular: kindOf(path.join(absolute, entry)) === 'file' }))
  return { name, directory: true, entries }
}

function listDaemonRun(root: string, name: string): DaemonRunListing {
  const run = `${ATTACH_RUNTIME_DAEMON}/${name}`
  if (kindOf(path.join(root, run)) !== 'directory')
    return { name, directory: false, objects: [] }
  return { name, directory: true, objects: readdirSync(path.join(root, run)).map(object => listRun(root, run, object)) }
}

function directoryKind(kind: ReturnType<typeof kindOf>): 'absent' | 'directory' | 'other' {
  return kind === 'absent' || kind === 'directory' ? kind : 'other'
}

export function readRuntimeListing(root: string): RuntimeListing {
  const browser = directoryKind(kindOf(path.join(root, ATTACH_RUNTIME_BROWSER)))
  const daemon = directoryKind(kindOf(path.join(root, ATTACH_RUNTIME_DAEMON)))
  return {
    regularFiles: ATTACH_RUNTIME_FILES.filter(target => kindOf(path.join(root, target)) === 'file'),
    browser,
    runs: browser === 'directory' ? readdirSync(path.join(root, ATTACH_RUNTIME_BROWSER)).map(name => listRun(root, ATTACH_RUNTIME_BROWSER, name)) : [],
    daemon,
    daemonRuns: daemon === 'directory' ? readdirSync(path.join(root, ATTACH_RUNTIME_DAEMON)).map(name => listDaemonRun(root, name)) : [],
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

function browserEntriesHeldAtAttach(record: AttachRecord): Set<string> | null {
  const names: unknown = record.browserHeld
  return Array.isArray(names) && names.every(name => typeof name === 'string') ? new Set(names) : null
}

function isShot(entry: { name: string, regular: boolean }): boolean {
  return entry.regular && entry.name.endsWith(ATTACH_RUNTIME_SHOT_SUFFIX)
}

function daemonRunRemovable(run: DaemonRunListing, tracked: Set<string>): boolean {
  return ATTACH_RUNTIME_RUN_DIRECTORY.test(run.name) && run.directory && run.objects.every(object => object.directory
    && object.entries.every(entry => entry.regular && !tracked.has(`${ATTACH_RUNTIME_DAEMON}/${run.name}/${object.name}/${entry.name}`)))
}

function daemonRemoval(listing: RuntimeListing, tracked: Set<string>): RuntimeRemoval['runs'] {
  const runs = listing.daemonRuns.filter(run => daemonRunRemovable(run, tracked)).flatMap((run) => {
    const directory = `${ATTACH_RUNTIME_DAEMON}/${run.name}`
    const objects = run.objects.map(object => ({ directory: `${directory}/${object.name}`, shots: object.entries.map(entry => `${directory}/${object.name}/${entry.name}`) }))
    return [...objects, { directory, shots: [] }]
  })
  return [...runs, { directory: ATTACH_RUNTIME_DAEMON, shots: [] }]
}

export function classifyRuntime(record: AttachRecord, tracked: Set<string>, listing: RuntimeListing): RuntimeRemoval {
  const held = heldAtAttach(record)
  const files = listing.regularFiles.filter(target => !tracked.has(target) && !held(target))
  const browserFree = listing.browser === 'directory' && !held(ATTACH_RUNTIME_BROWSER)
  const heldNames = browserEntriesHeldAtAttach(record)
  const guestRunsOnly = listing.browser === 'directory' && Array.isArray(record.ledgerHeld) && !browserFree && heldNames != null
  const runs = browserFree || guestRunsOnly
    ? listing.runs.filter(run => ATTACH_RUNTIME_RUN_DIRECTORY.test(run.name) && run.directory && (browserFree || heldNames?.has(run.name) === false) && run.entries.every(isShot) && run.entries.every(entry => !tracked.has(`${ATTACH_RUNTIME_BROWSER}/${run.name}/${entry.name}`)))
    : []
  const daemonFree = listing.daemon === 'directory' && !held(ATTACH_RUNTIME_DAEMON)
  return {
    files,
    runs: [
      ...runs.map(run => ({ directory: `${ATTACH_RUNTIME_BROWSER}/${run.name}`, shots: run.entries.map(entry => `${ATTACH_RUNTIME_BROWSER}/${run.name}/${entry.name}`) })),
      ...(daemonFree ? daemonRemoval(listing, tracked) : []),
    ],
    browser: browserFree,
  }
}
