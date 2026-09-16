import { describe, expect, it } from 'vitest'
import { COMPOSITION_DIR, loadCompositionModels, missingPaths, REPO_ROOT } from '../../composition/files.js'

describe('composition models on disk', () => {
  it('load, are named after their id and point only at files that exist', () => {
    const loaded = loadCompositionModels(COMPOSITION_DIR)
    expect(loaded.length).toBeGreaterThan(0)
    for (const { model, file } of loaded) {
      expect(file).toBe(`${model.id}.yaml`)
      expect(missingPaths(model, REPO_ROOT)).toEqual([])
    }
  })

  it('reports a node path that does not exist', () => {
    const [{ model }] = loadCompositionModels(COMPOSITION_DIR)
    const broken = { ...model, nodes: [{ id: 'x', label: 'x', path: 'src/nowhere/file.ts' }] }
    expect(missingPaths(broken, REPO_ROOT)).toEqual(['src/nowhere/file.ts'])
  })
})
