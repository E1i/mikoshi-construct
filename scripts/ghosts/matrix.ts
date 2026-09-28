import { readFileSync } from 'node:fs'

export interface MatrixRow {
  task: string
  class: string
  contour: unknown
}

export interface MatrixLookup {
  class: string
  contour: unknown
}

export function matrixKeyFor(id: string): string {
  return /^\d+$/.test(id) ? `#${id}` : id
}

export function lookupMatrixRow(matrixPath: string | undefined, id: string): MatrixLookup | null {
  if (matrixPath === undefined)
    return null

  const parsed = JSON.parse(readFileSync(matrixPath, 'utf8')) as { rows: MatrixRow[] }
  const key = matrixKeyFor(id)
  const row = parsed.rows.find(candidate => candidate.task === key)
  if (row === undefined)
    return null

  return { class: row.class, contour: row.contour }
}
