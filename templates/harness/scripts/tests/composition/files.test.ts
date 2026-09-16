import { describe, expect, it } from 'vitest'
import { COMPOSITION_DIR, loadCompositionModels, missingPaths, REPO_ROOT } from '../../composition/files.js'

describe('composition models on disk', () => {
  it('are named after their id and point only at files that exist', () => {
    for (const { model, file } of loadCompositionModels(COMPOSITION_DIR)) {
      expect(file).toBe(`${model.id}.yaml`)
      expect(missingPaths(model, REPO_ROOT)).toEqual([])
    }
  })

  it('reports a node path that does not exist', () => {
    const broken = { id: 'x', title: 'x', doc: 'architecture/x.md', boundaries: [], edges: [], nodes: [{ id: 'x', label: 'x', path: 'src/nowhere/file.ts' }] }
    expect(missingPaths(broken, REPO_ROOT)).toEqual(['src/nowhere/file.ts'])
  })
})
