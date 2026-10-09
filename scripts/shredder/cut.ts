export interface Slice {
  id: string
  defines: string[]
  calls: string[]
}

function callsOwnCode(slice: Slice): boolean {
  return slice.defines.some(name => slice.calls.includes(name))
}

function callerOf(slice: Slice, slices: Slice[]): Slice | undefined {
  return slices.find(other => other !== slice && other.calls.some(name => slice.defines.includes(name)))
}

export function foldCalleesIntoCallers(slices: Slice[]): string[][] {
  const groupOf = new Map<string, string>(slices.map(slice => [slice.id, slice.id]))
  const root = (id: string): string => {
    const parent = groupOf.get(id)!
    return parent === id ? id : root(parent)
  }
  for (const slice of slices) {
    if (callsOwnCode(slice))
      continue
    const caller = callerOf(slice, slices)
    if (caller !== undefined)
      groupOf.set(root(slice.id), root(caller.id))
  }
  const groups = new Map<string, string[]>()
  for (const slice of slices) {
    const key = root(slice.id)
    groups.set(key, [...(groups.get(key) ?? []), slice.id])
  }
  return [...groups.values()]
}
