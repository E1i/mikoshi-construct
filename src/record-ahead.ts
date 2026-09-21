export class RecordAheadOfReader extends Error {
  readonly record: string
  readonly field: string
  readonly found: number
  readonly understood: number

  constructor(record: string, field: string, found: number, understood: number) {
    super(`${record} declares ${field} ${found}; this binary understands ${understood}`)
    this.name = 'RecordAheadOfReader'
    this.record = record
    this.field = field
    this.found = found
    this.understood = understood
  }
}
