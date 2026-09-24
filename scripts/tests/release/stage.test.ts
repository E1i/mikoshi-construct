import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStageRecord, stageFor, stageIdFrom } from '../../release/stage.js'

const STAGE_ID = '0f8e2c1a-5b7d-4e3f-9a21-6c4d8b0e7f12'

function recordFile(body: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'construct-stage-')), 'release-stage.json')
  writeFileSync(file, body)
  return file
}

describe('the stage id npm reports is carried into a record', () => {
  it('reads the stage id npm stage publish --json nests under the package name', () => {
    const stdout = JSON.stringify({ 'mikoshi-construct': { id: 'mikoshi-construct@0.3.0', name: 'mikoshi-construct', version: '0.3.0', stageId: STAGE_ID } })

    expect(stageIdFrom(stdout, 'mikoshi-construct')).toBe(STAGE_ID)
  })

  it('refuses a report without a stage id rather than recording a publish nobody can approve', () => {
    const stdout = JSON.stringify({ 'mikoshi-construct': { id: 'mikoshi-construct@0.3.0' } })

    expect(() => stageIdFrom(stdout, 'mikoshi-construct')).toThrow('no stage id for mikoshi-construct')
  })

  it('refuses output that is not the json report, such as a lifecycle script printing first', () => {
    expect(() => stageIdFrom(`NOISE\n${JSON.stringify({ 'mikoshi-construct': { stageId: STAGE_ID } })}`, 'mikoshi-construct')).toThrow()
  })
})

describe('the stage record the verification reads', () => {
  it('reads a record the Release run wrote', () => {
    expect(readStageRecord(recordFile(JSON.stringify({ version: '0.3.0', stageId: STAGE_ID })))).toEqual({ version: '0.3.0', stageId: STAGE_ID })
  })

  it('reads a missing record as no stage, because a release that staged nothing uploads none', () => {
    expect(readStageRecord(path.join(tmpdir(), 'construct-stage-absent', 'release-stage.json'))).toBeUndefined()
  })

  it('refuses a record without a stage id instead of reading it as no stage', () => {
    expect(() => readStageRecord(recordFile(JSON.stringify({ version: '0.3.0' })))).toThrow('is not a stage record')
  })

  it('applies a record only to the version it staged', () => {
    const record = { version: '0.3.0', stageId: STAGE_ID }

    expect(stageFor(record, '0.3.0')).toBe(record)
    expect(stageFor(record, '0.4.0')).toBeUndefined()
    expect(stageFor(undefined, '0.3.0')).toBeUndefined()
  })
})
