export interface AnswerEvent {
  id: number
  type: string
  cardId: number | null
  payload: string
}

export interface OwnerAnswerTypes {
  waitOpened: string
  waitClosed: string
  decided: string
  cardWaiting: string
  turns: readonly string[]
  fieldsOf: (payload: string) => Record<string, unknown>
}

export type EventsOfTypes<E extends AnswerEvent> = (types: readonly string[], after: number) => E[]

function aCard(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

class AnswerHistory {
  constructor(private readonly events: readonly AnswerEvent[], private readonly types: OwnerAnswerTypes) {}

  private fieldsOf(event: AnswerEvent): Record<string, unknown> {
    return this.types.fieldsOf(event.payload)
  }

  answeredCards(event: AnswerEvent): number[] {
    const named = event.cardId === null ? [] : [event.cardId]
    return [...named, ...(event.type === this.types.waitClosed ? this.cardOfClosedWait(event) : this.scopeOf(event))]
  }

  waitedOn(card: number, before: number): boolean {
    return this.openWaitOn(card, before) || this.inCardWaiting(card, before)
  }

  private before(type: string, before: number): AnswerEvent[] {
    return this.events.filter(each => each.type === type && each.id < before)
  }

  private waitsOpenedBefore(before: number): Array<{ id: unknown, card: unknown }> {
    return this.before(this.types.waitOpened, before).map((opened) => {
      const fields = this.fieldsOf(opened)
      return { id: fields.id, card: opened.cardId ?? fields.card }
    })
  }

  private cardOfClosedWait(event: AnswerEvent): number[] {
    const wait = this.fieldsOf(event).id
    const card = typeof wait === 'string' ? this.waitsOpenedBefore(event.id).find(opened => opened.id === wait)?.card : undefined
    return aCard(card) ? [card] : []
  }

  private scopeOf(event: AnswerEvent): number[] {
    const scope = this.fieldsOf(event).scope
    return Array.isArray(scope) ? scope.filter(aCard) : []
  }

  private openWaitOn(card: number, before: number): boolean {
    const closed = new Set(this.before(this.types.waitClosed, before).map(each => this.fieldsOf(each).id))
    return this.waitsOpenedBefore(before).some(opened => opened.card === card && !closed.has(opened.id))
  }

  private lastOf(types: readonly string[], card: number, before: number): number {
    return Math.max(0, ...types.flatMap(type => this.before(type, before)).filter(each => each.cardId === card).map(each => each.id))
  }

  private inCardWaiting(card: number, before: number): boolean {
    const waiting = this.lastOf([this.types.cardWaiting], card, before)
    return waiting > 0 && waiting > this.lastOf(this.types.turns, card, before)
  }
}

export function ownerAnswersOfWaits<E extends AnswerEvent>(events: readonly E[], read: EventsOfTypes<E>, types: OwnerAnswerTypes): E[] {
  const answers = [types.waitClosed, types.decided]
  if (!events.some(event => answers.includes(event.type)))
    return [...events]
  const history = new AnswerHistory(read([types.waitOpened, types.waitClosed, types.decided, types.cardWaiting, ...types.turns], 0), types)
  return events.flatMap((event) => {
    if (!answers.includes(event.type))
      return [event]
    const card = history.answeredCards(event).find(each => history.waitedOn(each, event.id))
    return card === undefined ? [] : [{ ...event, cardId: card }]
  })
}
