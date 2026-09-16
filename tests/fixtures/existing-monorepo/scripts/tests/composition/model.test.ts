import { expect, it } from 'vitest'
import { model } from '../../composition/model.js'

it('model is wired', () => {
  expect(model).toBe('model')
})
