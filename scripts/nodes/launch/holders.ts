export interface Touching {
  touches: string[]
  body: string
}

export interface Claimant<P extends string = string> {
  cardId: number
  priority: P | null
}

export interface Holder<T extends Touching, P extends string = string> extends Claimant<P> {
  lane: string | null
  depends: number[]
  task: T | null
  ownerHeld: boolean
}

const UNCLEAR_LINE = /^unclear:[ \t]*(\S.*)$/m

export class HoldRule {
  constructor(private readonly order: readonly string[]) {}

  holdsAgainst<T extends Touching>(holder: Holder<T>, claimant: Claimant): boolean {
    return !this.yieldsTo(holder, claimant)
  }

  private rankOf(priority: string | null): number {
    const rank = priority === null ? -1 : this.order.indexOf(priority)
    return rank === -1 ? this.order.length : rank
  }

  private yieldsTo<T extends Touching>(holder: Holder<T>, claimant: Claimant): boolean {
    return holder.ownerHeld && this.rankOf(claimant.priority) < this.rankOf(holder.priority)
  }
}

export function holderOf<T extends Touching, P extends string>(card: Omit<Holder<T, P>, 'task' | 'ownerHeld'>, task: T | null, ownerHeld: boolean): Holder<T, P> {
  return { cardId: card.cardId, lane: card.lane, depends: card.depends, priority: card.priority, task, ownerHeld }
}

export function observedDiff(payload: Record<string, unknown>): string[] | null {
  const diff = Array.isArray(payload.paths) ? payload.paths.filter((each): each is string => typeof each === 'string') : []
  return diff.length === 0 || payload.pathsTruncated === true ? null : diff
}

export function withDiff<T extends Touching>(task: T | null, diff: string[] | null): T | null {
  return task === null || diff === null ? task : { ...task, touches: diff }
}

export function unclearField(task: Touching | null): string | null {
  return task === null ? null : UNCLEAR_LINE.exec(task.body)?.[1]?.trim() ?? null
}
