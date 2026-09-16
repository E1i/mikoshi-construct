import { expect, it } from 'vitest'
import { files } from '../../composition/files.js'

it('files is wired', () => {
  expect(files).toBe('files')
})
