import { describe, expect, it } from 'vitest'
import { importReaderFor } from '../src/model/imports/index.js'
import { scriptsOf, sfcScriptReader } from '../src/model/imports/sfc-script.js'
import { tsJsReader } from '../src/model/imports/ts-js.js'

describe('each file goes to the adapter that recognises it', () => {
  it.each([
    ['src/a.ts', tsJsReader],
    ['src/a.tsx', tsJsReader],
    ['src/a.mjs', tsJsReader],
    ['src/a.cjs', tsJsReader],
    ['src/A.vue', sfcScriptReader],
    ['src/A.svelte', sfcScriptReader],
    ['src/a.astro', sfcScriptReader],
  ])('%s', (file, reader) => {
    expect(importReaderFor(file)).toBe(reader)
  })

  it('gives a file no adapter recognises no reader', () => {
    expect(importReaderFor('README.md')).toBeUndefined()
    expect(importReaderFor('src/shader.glsl')).toBeUndefined()
  })
})

describe('the sfc-script adapter hands only the script blocks to the TS/JS adapter', () => {
  it('keeps every script block and the leading fence, blanks the rest and keeps each line where it was', () => {
    const source = '---\nimport A from \'./a.ts\'\n---\n<p>import B from \'./b.ts\'</p>\n<script lang="ts">\nimport C from \'./c.ts\'\n</script>\n<script>import D from \'./d.ts\'</script>\n'
    const kept = scriptsOf(source)
    expect(kept.split('\n')).toHaveLength(source.split('\n').length)
    expect(sfcScriptReader.read(source).imports.map(entry => `${entry.line} ${entry.specifier}`)).toEqual(['2 ./a.ts', '6 ./c.ts', '8 ./d.ts'])
  })

  it('keeps a script block in place behind markup that holds a character outside the basic plane', () => {
    expect(sfcScriptReader.read('<p>🌸🌸</p>\n<script>\nimport { go } from \'./go.ts\'\ngo()\n</script>\n').imports.map(entry => `${entry.line} ${entry.specifier} ${entry.bindings.join(',')}`)).toEqual(['3 ./go.ts go'])
  })

  it('reads nothing from markup outside a script block', () => {
    expect(sfcScriptReader.read('<template>\n  <p>import { x } from \'./x.ts\'</p>\n</template>\n').imports).toEqual([])
  })

  it('takes a fence only at the start of the file', () => {
    expect(sfcScriptReader.read('<p>a</p>\n---\nimport A from \'./a.ts\'\n---\n').imports).toEqual([])
  })

  it('reads the calls in a script block through the bindings it imports', () => {
    expect(sfcScriptReader.read('<script>\nimport { go } from \'./go.ts\'\ngo()\n</script>\n').calls).toEqual([{ name: 'go', member: false, line: 3 }])
  })
})
