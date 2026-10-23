import process from 'node:process'
import { openBus } from '../../bus/db.js'
import { ANSWER_SOURCE, requestFromWindow, WindowRequests } from '../../bus/window-requests.js'

const [busPath, channel, words, startAt] = process.argv.slice(2)
function refuse(): never {
  throw new Error('not this request')
}
const db = openBus(busPath!)
try {
  requestFromWindow(db, new Date().toISOString(), 'window-race', { kind: 'decisions:add', text: `[owner] ${words!}`, from: ANSWER_SOURCE, cards: [], supersedes: [] })
  const requests = new WindowRequests(db, () => new Date(), { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: () => ({ code: 0, lines: ['written'] }), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }, channel!)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(startAt) - Date.now()))
  console.log(requests.run().map(outcome => outcome.kind).join(','))
}
finally {
  db.close()
}
