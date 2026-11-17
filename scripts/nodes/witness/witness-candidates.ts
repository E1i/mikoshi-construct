import type { DatabaseSync } from 'node:sqlite'
import type { Admits, CandidateRules, QueuedTask, QueueSource, RequeueRow } from '../../core/queue.js'
import { CARD_BODIES } from '../../core/card-bodies.js'
import { CARD_CLOSED, CARD_STARTED, POLICY_DENIED, WITNESS_RECORDED } from '../../core/events.js'
import { MAIN_BRANCH } from '../../core/identifiers.js'
import { candidateRows, cardBodyShaOf, everyRow, openCandidates, WITHDRAWN } from '../../core/queue.js'

export interface WitnessParts {
  rules: CandidateRules
  namesWitnesses: Admits
}

const WITNESS_CANDIDATES_ON_NO_RECORD = `
  SELECT pr, card_id, head, ${cardBodyShaOf('prs.card_id')} AS card_body, NULL AS witness_base FROM prs
  WHERE state = 'open' AND base = '${MAIN_BRANCH}' AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
    AND ${cardBodyShaOf('prs.card_id')} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events AS recorded WHERE recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = prs.card_id AND recorded.head = prs.head
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf('prs.card_id')}
    )
  ORDER BY pr
`

const WITNESS_CANDIDATES_ON_MAIN = `
  SELECT NULL AS pr, body.card_id, (SELECT sha FROM mains ORDER BY event_id DESC LIMIT 1) AS head, ${cardBodyShaOf('body.card_id')} AS card_body, NULL AS witness_base, body.text
  FROM ${CARD_BODIES} AS body
  WHERE EXISTS (SELECT 1 FROM mains)
    AND ${cardBodyShaOf('body.card_id')} IS NOT NULL
    AND EXISTS (SELECT 1 FROM events AS started WHERE started.type = '${CARD_STARTED}' AND started.legacy = 0 AND started.card_id = body.card_id)
    AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.card_id = body.card_id)
    AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.card_id = body.card_id AND cards.state IN ('closed', 'dropped', 'merged'))
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${CARD_CLOSED}' AND closed.card_id = body.card_id)
    AND NOT EXISTS (
      SELECT 1 FROM events AS recorded WHERE recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = body.card_id AND recorded.pr IS NULL
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf('body.card_id')}
    )
  ORDER BY body.card_id
`

const LATEST_WITNESS_DENIAL = `
  SELECT max(latest.id) FROM events AS latest
  WHERE latest.type = '${POLICY_DENIED}' AND latest.legacy = 0 AND latest.card_id = denied.card_id AND latest.head = denied.head
    AND json_extract(latest.payload, '$.reason') = 'witness'
`

const WITNESS_CANDIDATES_ON_A_DENIED_BASE = `
  SELECT denied.pr, denied.card_id, denied.head, ${cardBodyShaOf('denied.card_id')} AS card_body, json_extract(denied.payload, '$.base') AS witness_base FROM events AS denied
  WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.pr IS NOT NULL AND denied.card_id IS NOT NULL AND denied.head IS NOT NULL
    AND json_extract(denied.payload, '$.reason') = 'witness' AND json_type(denied.payload, '$.base') = 'text'
    AND denied.id = (${LATEST_WITNESS_DENIAL})
    AND ${cardBodyShaOf('denied.card_id')} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events AS recorded WHERE recorded.type = '${WITNESS_RECORDED}' AND recorded.legacy = 0
        AND recorded.card_id = denied.card_id AND recorded.head = denied.head
        AND json_extract(recorded.payload, '$.cardBody') = ${cardBodyShaOf('denied.card_id')}
        AND json_extract(recorded.payload, '$.base') = json_extract(denied.payload, '$.base')
    )
  ORDER BY denied.id
`

const WITHDRAWN_ON_A_WITNESS_NOW_GREEN = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  WHERE tasks.queue IN ('merge', 'close') AND tasks.state = '${WITHDRAWN}' AND tasks.head IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM events AS denied
      JOIN events AS green ON green.type = '${WITNESS_RECORDED}' AND green.legacy = 0 AND green.card_id = denied.card_id AND green.head = denied.head
      WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.card_id = tasks.card_id AND denied.head = tasks.head
        AND json_extract(denied.payload, '$.reason') = 'witness' AND json_extract(denied.payload, '$.command') = tasks.queue
        AND denied.id = (${LATEST_WITNESS_DENIAL} AND json_extract(latest.payload, '$.command') = tasks.queue)
        AND green.id > tasks.event_id AND json_extract(green.payload, '$.verdict') = 'green'
        AND json_extract(green.payload, '$.base') = json_extract(denied.payload, '$.base')
    )
    AND (tasks.queue = 'close' OR EXISTS (SELECT 1 FROM prs WHERE prs.pr = tasks.pr AND prs.state = 'open' AND prs.head = tasks.head))
  ORDER BY tasks.task_key
`

export function witnessCandidates(db: DatabaseSync, ts: string, parts: WitnessParts): QueuedTask[] {
  const rows = [...candidateRows(db, WITNESS_CANDIDATES_ON_NO_RECORD, everyRow), ...candidateRows(db, WITNESS_CANDIDATES_ON_A_DENIED_BASE, everyRow), ...candidateRows(db, WITNESS_CANDIDATES_ON_MAIN, parts.namesWitnesses)]
  return openCandidates(db, ts, 'witness', rows, parts.rules)
}

export function witnessSource(): QueueSource {
  return { queue: 'witness', requeue: db => db.prepare(WITHDRAWN_ON_A_WITNESS_NOW_GREEN).all() as unknown as RequeueRow[] }
}
