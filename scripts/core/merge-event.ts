export interface MergeEvent {
  event: 'merge'
  task: string
  pr?: number
  merged?: string
  by: string
  commit: string
  ts: string
}
