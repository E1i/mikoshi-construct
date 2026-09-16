import { expect, it } from 'vitest'
import { render } from '../../composition/render.js'

it('render is wired', () => {
  expect(render).toBe('render')
})
