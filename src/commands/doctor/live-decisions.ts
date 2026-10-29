const DECISION_LINE = /^\s*[-*+]\s+D-([1-9]\d*) · \S+(?: ~\S+)? — (.+)$/
const SUPERSEDES = /^supersedes ((?:D-[1-9]\d*(?: |$))+)/
const TERM = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?Z'
const UNTIL = new RegExp(`^until (${TERM})$`)
const TRAILING_UNTIL = new RegExp(`\\s(?:· )?until (${TERM})$`)
const UNTIL_ATTEMPT = /\buntil\W*\d{4}-\d{2}-\d{2}/i
const SUPERSEDED_BY = /^superseded-by D-[1-9]\d*$/
const SUPERSEDING_MENTION = /superseded-by|\bsupersedes D-\d/i
const OWNER_PREFIX = '[owner] '
const TAIL_SEPARATOR = ' · '
const TAILS_IN_ORDER = [/^supersedes D-/, /^card #/, /^until /, /^decisions:add$/, /^superseded-by D-/]

interface LiveDecision {
  number: number
  body: string
  supersedes: number[]
  lapsedBy: (now: Date) => boolean
  superseded: boolean
}

function calendarTerm(until: string): boolean {
  const ms = Date.parse(until)
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(until.slice(0, -1))
}

function termOf(body: string, tail: string | undefined): (now: Date) => boolean {
  const trailing = TRAILING_UNTIL.exec(body)
  const rest = trailing === null ? body : body.slice(0, trailing.index)
  const terms = [tail, trailing?.[1]].filter(term => term !== undefined)
  const until = terms[0]
  const unread = terms.length > 1 || UNTIL_ATTEMPT.test(rest) || (until !== undefined && !calendarTerm(until))
  return now => unread || (until !== undefined && Date.parse(until) <= now.getTime())
}

function tailsInOrder(tails: readonly string[]): boolean {
  const ranks = tails.map(tail => TAILS_IN_ORDER.findIndex(kind => kind.test(tail)))
  return ranks.every((rank, index) => rank !== -1 && (index === 0 || rank > ranks[index - 1]!))
}

function decisionOf(line: string): LiveDecision | null {
  const match = DECISION_LINE.exec(line)
  if (match === null)
    return null
  const parts = match[2]!.split(TAIL_SEPARATOR)
  const firstTail = parts.findIndex((_, index) => index > 0 && tailsInOrder(parts.slice(index)))
  const body = (firstTail === -1 ? parts : parts.slice(0, firstTail)).join(TAIL_SEPARATOR).trim()
  const tails = firstTail === -1 ? [] : parts.slice(firstTail)
  if (SUPERSEDING_MENTION.test(body))
    return null
  const supersedes = tails.flatMap(tail => SUPERSEDES.exec(tail)?.[1]?.trim().split(' ').map(reference => Number(reference.slice(2))) ?? [])
  const until = tails.map(tail => UNTIL.exec(tail)?.[1]).find(term => term !== undefined)
  return { number: Number(match[1]), body, supersedes, lapsedBy: termOf(body, until), superseded: tails.some(tail => SUPERSEDED_BY.test(tail)) }
}

function queueNamedLive(body: string): string | null {
  const live = new RegExp(`^(?:${OWNER_PREFIX.replace(/[[\]]/g, '\\$&')})?allow-live (\\S+)(?: · until \\S+)?$`).exec(body)
  return live?.[1] ?? null
}

export function liveQueuesIn(text: string, now: Date): Set<string> {
  const decisions = text.split(/\r?\n/).map(decisionOf).filter(decision => decision !== null)
  const retired = new Set(decisions.flatMap(decision => decision.supersedes))
  const inForce = decisions.filter(decision => !decision.superseded && !retired.has(decision.number) && !decision.lapsedBy(now))
  return new Set(inForce.map(decision => queueNamedLive(decision.body)).filter(queue => queue !== null))
}
