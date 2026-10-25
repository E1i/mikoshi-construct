const HAND_LADDER_POLICY = 'hand-ladder-'
const HAND_LADDER_ROW = /^\| hand-ladder-(\S+) \|/

export function handLadderPolicy(id: string): string {
  return `${HAND_LADDER_POLICY}${id}`
}

export function handLadderRows(statusText: string | undefined): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of (statusText ?? '').split('\n')) {
    const id = HAND_LADDER_ROW.exec(line)?.[1]
    if (id !== undefined)
      rows.set(id, line.split('|').map(cell => cell.trim()).at(-2) ?? '')
  }
  return rows
}
