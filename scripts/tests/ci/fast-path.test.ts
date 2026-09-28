import { describe, expect, it } from 'vitest'
import { isFastPath } from '../../ci/fast-path.js'

const CASES: { name: string, paths: string[], fastPath: boolean }[] = [
  { name: 'a markdown page under docs/', paths: ['docs/guide/x.md'], fastPath: true },
  { name: 'several pages under docs/ and a top-level architecture record', paths: ['docs/cli.md', 'docs/guide/y.md', 'architecture/observations.md'], fastPath: true },
  { name: 'a top-level architecture record', paths: ['architecture/principles.md'], fastPath: true },
  { name: 'AGENTS.md', paths: ['AGENTS.md'], fastPath: false },
  { name: 'CLAUDE.md', paths: ['CLAUDE.md'], fastPath: false },
  { name: 'a template', paths: ['templates/x'], fastPath: false },
  { name: 'a file under .claude/', paths: ['.claude/x'], fastPath: false },
  { name: 'a markdown file below architecture/', paths: ['architecture/sub/x.md'], fastPath: false },
  { name: 'a non-markdown file at the top of architecture/', paths: ['architecture/x.yaml'], fastPath: false },
  { name: 'a docs page beside a source file', paths: ['docs/x.md', 'src/x.ts'], fastPath: false },
  { name: 'a changeset', paths: ['.changeset/a.md'], fastPath: false },
  { name: 'the changelog', paths: ['CHANGELOG.md'], fastPath: false },
  { name: 'package.json', paths: ['package.json'], fastPath: false },
  { name: 'a near-miss of docs/', paths: ['docs.md'], fastPath: false },
  { name: 'docs/ nested under templates/', paths: ['templates/docs/x.md'], fastPath: false },
  { name: 'no paths at all', paths: [], fastPath: false },
]

describe('the fast-path allow-list', () => {
  for (const { name, paths, fastPath } of CASES) {
    it(`reads ${name} as ${fastPath ? 'the fast path' : 'the full path'}`, () => {
      expect(isFastPath(paths)).toBe(fastPath)
    })
  }
})
