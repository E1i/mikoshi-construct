import type { Slice } from './cut.js'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { foldCalleesIntoCallers } from './cut.js'
import { buildRows } from './matrix.js'
import { MissingSnapshotFileError, readSnapshot } from './reader.js'
import { toJson, toTable } from './render.js'
import { buildTaskRow } from './task.js'

function printCut(cutPath: string): void {
  const slices = JSON.parse(readFileSync(cutPath, 'utf8')) as Slice[]
  process.stdout.write(`${JSON.stringify(foldCalleesIntoCallers(slices), null, 2)}\n`)
}

function main(): void {
  const args = process.argv.slice(2)
  const cutIndex = args.indexOf('--cut')
  if (cutIndex !== -1 && args[cutIndex + 1] !== undefined) {
    printCut(args[cutIndex + 1]!)
    return
  }
  const asJson = args.includes('--json')
  const dir = args.find(arg => arg !== '--json')
  if (dir == null) {
    process.stderr.write('a snapshot directory is required\n')
    process.exitCode = 1
    return
  }

  let snapshot
  try {
    snapshot = readSnapshot(dir)
  }
  catch (error) {
    if (error instanceof MissingSnapshotFileError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }

  const taskRows = snapshot.tasks.map(taskFile => buildTaskRow(taskFile, snapshot.files))
  const { rows, notChecked } = buildRows(taskRows, snapshot.windows, snapshot.policies, snapshot.ownerMergeKinds, snapshot.openPrs)

  if (asJson)
    process.stdout.write(`${JSON.stringify(toJson(rows, notChecked), null, 2)}\n`)
  else
    process.stdout.write(`${toTable(rows, notChecked)}\n`)
}

main()
