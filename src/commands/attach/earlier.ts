import type { Buffer } from 'node:buffer'
import type { Ui } from '../../ui/console.js'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { templatesRoot } from '../../materialize/templates.js'
import { ATTACH_CARRIERS } from '../../presets/index.js'

export interface EarlierCarrier {
  target: string
  sha256: string
  date: string
}

export interface CollisionFlags {
  harness?: string
  yes: boolean
}

export interface CollisionReading {
  labels: Array<EarlierCarrier | null>
  remove: string | null
  rerun: string
}

const SHELL_SAFE_WORD = /^[\w./@:=-]+$/

function attachTemplate(name: string): string {
  return path.join(templatesRoot(), 'attach', name)
}

function shellWord(word: string): string {
  return SHELL_SAFE_WORD.test(word) ? word : JSON.stringify(word)
}

export function knownCarriers(): EarlierCarrier[] {
  return JSON.parse(readFileSync(attachTemplate('earlier-carriers.json'), 'utf8')) as EarlierCarrier[]
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bytesOfRegularFileInside(root: string, target: string): Buffer | null {
  const file = path.join(root, target)
  try {
    if (!lstatSync(file).isFile())
      return null
    if (realpathSync(file) !== path.join(realpathSync(root), target))
      return null
    return readFileSync(file)
  }
  catch {
    return null
  }
}

export function classifyCollisions(root: string, paths: string[]): Array<EarlierCarrier | null> {
  const known = knownCarriers()
  const carrierTargets: readonly string[] = ATTACH_CARRIERS.targets
  return paths.map((target) => {
    if (!carrierTargets.includes(target))
      return null
    const bytes = bytesOfRegularFileInside(root, target)
    if (bytes == null)
      return null
    const sha256 = sha256OfBytes(bytes)
    return known.find(entry => entry.target === target && entry.sha256 === sha256) ?? null
  })
}

function rerunCommand(root: string, flags: CollisionFlags): string {
  const base = `npx mikoshi-construct attach --dir ${shellWord(root)}`
  if (flags.harness == null)
    return base
  return `${base}${flags.yes ? ' --yes' : ''} --harness ${JSON.stringify(flags.harness)}`
}

export function collisionReading(root: string, paths: string[], flags: CollisionFlags): CollisionReading {
  const labels = classifyCollisions(root, paths)
  const recognised = paths.filter((_, index) => labels[index] != null)
  return {
    labels,
    remove: recognised.length === 0 ? null : `cd ${shellWord(root)} && rm -- ${recognised.map(shellWord).join(' ')}`,
    rerun: rerunCommand(root, flags),
  }
}

export function printEntryProtocol(ui: Ui): void {
  ui.line(readFileSync(attachTemplate('entry.md'), 'utf8').trimEnd())
}
