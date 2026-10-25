import type { StartedBus } from './card-started-bus.js'
import process from 'node:process'
import { afterEach, beforeEach } from 'vitest'
import { BUS_DB_VARIABLE } from '../../core/db.js'
import { busWithCardStarted } from './card-started-bus.js'

export function ownBusPerTest(): () => string {
  let bus: StartedBus | undefined
  let before: string | undefined

  beforeEach(() => {
    before = process.env[BUS_DB_VARIABLE]
    bus = busWithCardStarted([])
    process.env[BUS_DB_VARIABLE] = bus.file
  })

  afterEach(() => {
    process.env[BUS_DB_VARIABLE] = before
    bus?.remove()
    bus = undefined
  })

  return () => bus!.file
}
