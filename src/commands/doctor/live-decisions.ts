const DECISION_LINE = /^\s*[-*+]\s+D-([1-9]\d*) · \S+(?: ~\S+)? — (.+)$/
const SUPERSEDES = /^supersedes ((?:D-[1-9]\d*(?: |$))+)/
const UNTIL = /^until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$/
const SUPERSEDED_BY = /^superseded-by D-[1-9]\d*$/
const OWNER_PREFIX = '[owner] '
const TAIL_SEPARATOR = ' · '

interface LiveDecision {
  number: number
  body: string
  supersedes: number[]
  until: string | null
  superseded: boolean
}

function decisionOf(line: string): LiveDecision | null {
  const match = DECISION_LINE.exec(line)
  if (match === null)
    return null
  const [body = '', ...tails] = match[2]!.split(TAIL_SEPARATOR)
  const supersedes = tails.flatMap(tail => SUPERSEDES.exec(tail)?.[1]?.trim().split(' ').map(reference => Number(reference.slice(2))) ?? [])
  const until = tails.map(tail => UNTIL.exec(tail)?.[1]).find(term => term !== undefined) ?? null
  return { number: Number(match[1]), body: body.trim(), supersedes, until, superseded: tails.some(tail => SUPERSEDED_BY.test(tail)) }
}

function allowLiveText(queue: string): string {
  return `allow-live ${queue}`
}

export function liveQueuesIn(text: string, now: Date): Set<string> {
  const decisions = text.split(/\r?\n/).map(decisionOf).filter(decision => decision !== null)
  const retired = new Set(decisions.flatMap(decision => decision.supersedes))
  const inForce = decisions.filter(decision => !decision.superseded && !retired.has(decision.number) && (decision.until === null || Date.parse(decision.until) > now.getTime()))
  return new Set(inForce.map(decision => decision.body.replace(OWNER_PREFIX, '')).filter(body => body.startsWith(allowLiveText(''))).map(body => body.slice(allowLiveText('').length)))
}
