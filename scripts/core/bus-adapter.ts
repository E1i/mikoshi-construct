import { busDirOf, defaultBusPath } from './bus-path.js'
import { CARD_VERSION, cardVersionIn } from './bus-version.js'
import { appendEvent, BOARD_TIMER_PROCESS, BUSY_TIMEOUT_MS, inTransaction, OPEN_WAIT, openBus, openBusWait } from './db.js'
import { messageOf } from './errors.js'
import { byId, events, latest, ofCard, perCard } from './events-query.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease, waitTask } from './lease.js'
import { DATABASE_LOCKED, isDatabaseLocked } from './node.js'
import { keyOf, NEEDS_UPDATE, QUESTION_OPEN, QUEUE_ACTOR, reviewsInFlightOn, widenedOnTheAdmission } from './queue.js'
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
  assertHeld,
  completeTask,
  waitTask,
  failTask,
  releaseTask,
  isStaleLease: (error: unknown) => error instanceof StaleLease,
  keyOf,
  openOwnerWait: openBusWait,
  reviewsInFlightOn,
  widenedOnTheAdmission,
  messageOf,
  queueActor: QUEUE_ACTOR,
  needsUpdate: NEEDS_UPDATE,
  questionOpen: QUESTION_OPEN,
  open: openBus,
  defaultPath: defaultBusPath,
  dirOf: busDirOf,
  inTransaction,
  isLocked: isDatabaseLocked,
  lockedText: DATABASE_LOCKED,
  boardTimerProcess: BOARD_TIMER_PROCESS,
} as const
