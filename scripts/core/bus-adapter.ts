import { CARD_VERSION, cardVersionIn } from './bus-version.js'
import { appendEvent, BUSY_TIMEOUT_MS, OPEN_WAIT } from './db.js'
import { byId, events, latest, ofCard, perCard } from './events-query.js'
import { openDatabase } from './sqlite.js'
import * as tasks from './tasks-query.js'
import { lastEventId, markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const BUS_CONTRACT = {
  appendEvent,
  events,
  latest,
  byId,
  ofCard,
  perCard,
  tasksOfCard: tasks.ofCard,
  lastEventId,
  watermarkOf,
  markReduced,
  reduceProjection,
  openReadOnly: (file: string) => openDatabase(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS }),
  openWait: OPEN_WAIT,
  cardVersion: { current: CARD_VERSION, of: cardVersionIn },
}
