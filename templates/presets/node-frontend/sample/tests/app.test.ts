import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

describe('createApp', () => {
  it('mounts the counter and keeps its state in data attributes', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const counter = createApp(root)
    expect(root.querySelector('h1')).not.toBeNull()
    expect(counter.element.dataset.count).toBe('0')
    expect(counter.element.dataset.tone).toBe('idle')

    counter.increment()
    counter.increment()

    expect(counter.value()).toBe(2)
    expect(counter.element.dataset.count).toBe('2')
    expect(counter.element.dataset.tone).toBe('active')
    expect(counter.element.className).toBe('counter')
  })
})
