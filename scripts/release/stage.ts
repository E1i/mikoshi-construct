import { existsSync, readFileSync } from 'node:fs'

export const STAGE_ARTIFACT = 'release-stage'
export const STAGE_RECORD_FILE = 'release-stage.json'

export interface StageRecord {
  version: string
  stageId: string
}

function isStageRecord(value: unknown): value is StageRecord {
  if (value === null || typeof value !== 'object')
    return false
  const { version, stageId } = value as Record<string, unknown>
  return typeof version === 'string' && version !== '' && typeof stageId === 'string' && stageId !== ''
}

export function stageIdFrom(stdout: string, packageName: string): string {
  const parsed = JSON.parse(stdout) as Record<string, { stageId?: unknown } | undefined>
  const stageId = parsed[packageName]?.stageId
  if (typeof stageId !== 'string' || stageId === '')
    throw new Error(`npm stage publish reported no stage id for ${packageName}: ${stdout}`)
  return stageId
}

export function readStageRecord(file: string): StageRecord | undefined {
  if (!existsSync(file))
    return undefined
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isStageRecord(parsed))
    throw new Error(`${file} is not a stage record: ${JSON.stringify(parsed)}`)
  return parsed
}

export function stageFor(record: StageRecord | undefined, version: string): StageRecord | undefined {
  return record?.version === version ? record : undefined
}
