import type { ParkingReads } from '../shift/parking.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { journalPath } from './import.js'

export function busParkingReads(busPath: string): ParkingReads {
  return {
    cwd: process.cwd(),
    handoffDir: path.dirname(journalPath()),
    listDir: dir => readdirSync(dir),
    read: target => readFileSync(target, 'utf8'),
    exists: existsSync,
    git: (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }),
    bus: busPath,
  }
}
