import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { laneName, laneNumber, laneTouches } from '../../../src/commands/intake/admit.js'
import { isLane, LANE_NAME, laneJsonProblems, readLaneJson, UNKNOWN, writeLaneJson } from '../../lanes/lane-json.js'

const VALID = { purpose: 'bus cards', touches: ['scripts/bus/**'], createdBy: 'owner', createdAt: '2026-10-11T12:00:00.000Z', status: 'open' }

const roots: string[] = []

function lane(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lane-json-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

describe('lane.json', () => {
  it('a lane.json with exactly the five fields has no problems', () => {
    expect(laneJsonProblems(VALID)).toEqual([])
    expect(laneJsonProblems({ ...VALID, touches: UNKNOWN })).toEqual([])
  })

  it('a field outside the contract, a missing field and a wrong type are each named', () => {
    const { status: _status, ...withoutStatus } = VALID
    expect(laneJsonProblems({ ...withoutStatus, purpose: '', touches: 'scripts/**', contour: 'cheap' })).toEqual([
      'contour is not a lane.json field',
      'status is missing',
      'purpose is not a non-empty string',
      `touches is neither '${UNKNOWN}' nor a list of non-empty strings`,
    ])
    expect(laneJsonProblems([])).toEqual(['lane.json is not an object'])
  })

  it('a written lane.json reads back and makes its directory a lane', () => {
    const dir = lane()
    expect(isLane(dir)).toBe(false)
    writeLaneJson(dir, VALID)
    expect(isLane(dir)).toBe(true)
    expect(readLaneJson(dir)).toEqual(VALID)
  })

  it('an invalid lane.json is refused on read and on write, naming the file', () => {
    const dir = lane()
    writeFileSync(path.join(dir, 'lane.json'), JSON.stringify({ ...VALID, kind: 'review' }))
    expect(() => readLaneJson(dir)).toThrow(`${path.join(dir, 'lane.json')}: kind is not a lane.json field`)
    expect(() => writeLaneJson(dir, { ...VALID, createdBy: '' })).toThrow('createdBy is not a non-empty string')
  })

  it('a lane is named lane-NN, and only such a name has a number', () => {
    expect(laneName(3)).toBe('lane-03')
    expect(laneName(112)).toBe('lane-112')
    expect(laneNumber('lane-07')).toBe(7)
    expect(laneNumber('lane-7')).toBeNull()
    expect(laneNumber('lane-bus-1')).toBeNull()
  })

  it('lane.json touches are read and a dated lane name is accepted', () => {
    const parking = lane()
    const dated = path.join(parking, '2026-10-19-a')
    mkdirSync(dated)
    writeLaneJson(dated, VALID)
    writeFileSync(path.join(dated, '5.md'), 'card: #5 five [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/five\ntouches: scripts/lanes/**\ncontinue: stop\nwho: shift\n\nBody.\n')
    expect(LANE_NAME.test('2026-10-19-a')).toBe(true)
    expect(LANE_NAME.test('lane-bus-1')).toBe(false)
    expect(laneNumber('2026-10-19-a')).toBeNull()
    expect(readLaneJson(dated).touches).toEqual(['scripts/bus/**'])
    expect(laneTouches(dated)).toEqual(['scripts/bus/**', 'scripts/lanes/**'])
  })
})
