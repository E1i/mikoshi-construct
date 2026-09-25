import { parse } from 'yaml'

export const EDGE_KINDS = ['sequence', 'parallel', 'route', 'fan-out', 'fan-in', 'wires'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

export interface Boundary {
  id: string
  label: string
}

export interface CompositionNode {
  id: string
  label: string
  path?: string
  boundary?: string
}

export interface CompositionEdge {
  from: string
  to: string
  kind: EdgeKind
  label?: string
}

export interface CompositionModel {
  id: string
  title: string
  description?: string
  doc: string
  boundaries: Boundary[]
  nodes: CompositionNode[]
  edges: CompositionEdge[]
}

const IDENTIFIER = /^[A-Z]\w*$/i

function fail(name: string, message: string): never {
  throw new Error(`${name}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function text(name: string, record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '')
    fail(name, `${where} needs a non-empty "${key}"`)
  return value
}

function optionalText(name: string, record: Record<string, unknown>, key: string, where: string): string | undefined {
  if (record[key] === undefined)
    return undefined
  return text(name, record, key, where)
}

function identifier(name: string, value: string, where: string): string {
  if (!IDENTIFIER.test(value))
    fail(name, `${where} id "${value}" must match ${IDENTIFIER}`)
  return value
}

function list(name: string, record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key] ?? []
  if (!Array.isArray(value) || !value.every(isRecord))
    fail(name, `"${key}" must be a list of objects`)
  return value
}

export function parseCompositionModel(source: string, name: string): CompositionModel {
  const raw: unknown = parse(source)
  if (!isRecord(raw))
    fail(name, 'the document must be a mapping')

  const boundaries = list(name, raw, 'boundaries').map((entry, index) => ({
    id: identifier(name, text(name, entry, 'id', `boundaries[${index}]`), `boundaries[${index}]`),
    label: text(name, entry, 'label', `boundaries[${index}]`),
  }))
  const boundaryIds = new Set(boundaries.map(boundary => boundary.id))
  if (boundaryIds.size !== boundaries.length)
    fail(name, 'boundary ids must be unique')

  const nodes = list(name, raw, 'nodes').map((entry, index) => {
    const where = `nodes[${index}]`
    const node: CompositionNode = {
      id: identifier(name, text(name, entry, 'id', where), where),
      label: text(name, entry, 'label', where),
    }
    const path = optionalText(name, entry, 'path', where)
    if (path != null)
      node.path = path
    const boundary = optionalText(name, entry, 'boundary', where)
    if (boundary != null) {
      if (!boundaryIds.has(boundary))
        fail(name, `${where} refers to unknown boundary "${boundary}"`)
      node.boundary = boundary
    }
    return node
  })
  const nodeIds = new Set(nodes.map(node => node.id))
  if (nodeIds.size !== nodes.length)
    fail(name, 'node ids must be unique')
  if (nodes.length === 0)
    fail(name, 'at least one node is required')

  const edges = list(name, raw, 'edges').map((entry, index) => {
    const where = `edges[${index}]`
    const from = text(name, entry, 'from', where)
    const to = text(name, entry, 'to', where)
    for (const endpoint of [from, to]) {
      if (!nodeIds.has(endpoint))
        fail(name, `${where} refers to unknown node "${endpoint}"`)
    }
    const kind = text(name, entry, 'kind', where)
    if (!(EDGE_KINDS as readonly string[]).includes(kind))
      fail(name, `${where} kind "${kind}" is not one of ${EDGE_KINDS.join(', ')}`)
    const edge: CompositionEdge = { from, to, kind: kind as EdgeKind }
    const label = optionalText(name, entry, 'label', where)
    if (label != null)
      edge.label = label
    return edge
  })

  const model: CompositionModel = {
    id: identifier(name, text(name, raw, 'id', 'the document'), 'the document'),
    title: text(name, raw, 'title', 'the document'),
    doc: text(name, raw, 'doc', 'the document'),
    boundaries,
    nodes,
    edges,
  }
  const description = optionalText(name, raw, 'description', 'the document')
  if (description != null)
    model.description = description
  return model
}
