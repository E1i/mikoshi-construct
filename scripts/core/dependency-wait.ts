import type { DatabaseSync } from 'node:sqlite'

export interface DependencyWaitNames {
  admitted: string
  backfillSource: string
  mergeDone: string
  prClosed: string
  prOpened: string
  prObserved: string
  settledUpdateStates: readonly string[]
}

export interface DependencyWait {
  unmerged: string
  updateDue: string
  held: string
  unmergedDependenciesOf: (db: DatabaseSync, cardId: number) => number[]
  updateDueOn: (db: DatabaseSync, head: { card: number, pr: number, head: string }) => boolean
}

function latestAdmissionDepends(names: DependencyWaitNames, card: string): string {
  return `
  SELECT depends.value AS card_id FROM json_each((
    SELECT admitted.payload FROM events AS admitted
    WHERE admitted.legacy = 0 AND admitted.type = '${names.admitted}' AND admitted.card_id = ${card}
      AND json_extract(admitted.payload, '$.source') IS NOT '${names.backfillSource}'
    ORDER BY admitted.id DESC LIMIT 1
  ), '$.depends') AS depends
  WHERE depends.type = 'integer'
`
}

function unmergedDependenciesWhere(names: DependencyWaitNames, card: string): string {
  return `
  SELECT dependency.card_id FROM (${latestAdmissionDepends(names, card)}) AS dependency
  WHERE NOT EXISTS (SELECT 1 FROM events AS done WHERE done.type = '${names.mergeDone}' AND done.legacy = 0 AND done.card_id = dependency.card_id)
    AND NOT EXISTS (SELECT 1 FROM prs AS merged WHERE merged.card_id = dependency.card_id AND merged.state = 'merged')
    AND NOT EXISTS (SELECT 1 FROM events AS legacy WHERE legacy.type = 'merge' AND legacy.legacy = 1 AND legacy.card_id = dependency.card_id)
  ORDER BY dependency.card_id
`
}

interface HeadRef {
  card: string
  pr: string
  head: string
}

const THE_PRS_ROW: HeadRef = { card: 'prs.card_id', pr: 'prs.pr', head: 'prs.head' }

const BOUND_PARAMETERS: HeadRef = { card: ':card', pr: ':pr', head: ':head' }

function aDependencyMergedUnderTheHead(names: DependencyWaitNames, at: HeadRef): string {
  return `EXISTS (
  SELECT 1 FROM (${latestAdmissionDepends(names, at.card)}) AS dependency
  JOIN events AS dependency_merge ON dependency_merge.card_id = dependency.card_id
    AND ((dependency_merge.type = '${names.mergeDone}' AND dependency_merge.legacy = 0) OR (dependency_merge.type = '${names.prClosed}' AND json_extract(dependency_merge.payload, '$.merged') = 1))
  WHERE dependency_merge.id > (SELECT min(seen.id) FROM events AS seen WHERE seen.pr = ${at.pr} AND seen.head = ${at.head} AND seen.type IN ('${names.prOpened}', '${names.prObserved}'))
    AND NOT EXISTS (SELECT 1 FROM tasks AS tried WHERE tried.queue = 'update' AND tried.pr = ${at.pr} AND tried.head = ${at.head}
      AND tried.state IN (${names.settledUpdateStates.map(state => `'${state}'`).join(', ')}) AND tried.event_id > dependency_merge.id)
)`
}

export function dependencyWaitOf(names: DependencyWaitNames): DependencyWait {
  const unmerged = `EXISTS (${unmergedDependenciesWhere(names, 'prs.card_id')})`
  const updateDue = `(NOT ${unmerged} AND ${aDependencyMergedUnderTheHead(names, THE_PRS_ROW)})`
  const ofACard = unmergedDependenciesWhere(names, '?')
  const mergedUnderABoundHead = `SELECT ${aDependencyMergedUnderTheHead(names, BOUND_PARAMETERS)} AS merged`
  const unmergedDependenciesOf = (db: DatabaseSync, cardId: number): number[] => (db.prepare(ofACard).all(cardId) as { card_id: number }[]).map(row => Number(row.card_id))
  return {
    unmerged,
    updateDue,
    held: `(${unmerged} OR ${updateDue})`,
    unmergedDependenciesOf,
    updateDueOn: (db, head) => unmergedDependenciesOf(db, head.card).length === 0
      && (db.prepare(mergedUnderABoundHead).get({ card: head.card, pr: head.pr, head: head.head }) as { merged: number }).merged === 1,
  }
}
