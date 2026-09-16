export interface Counter {
  element: HTMLButtonElement
  value: () => number
  increment: () => void
}

function render(element: HTMLButtonElement, count: number): void {
  element.dataset.count = String(count)
  element.dataset.tone = count > 0 ? 'active' : 'idle'
  element.textContent = `Clicked ${count} ${count === 1 ? 'time' : 'times'}`
}

export function createCounter(element: HTMLButtonElement): Counter {
  let count = 0
  render(element, count)
  element.addEventListener('click', () => {
    count += 1
    render(element, count)
  })
  return { element, value: () => count, increment: () => element.click() }
}

export function createApp(root: HTMLElement): Counter {
  const document = root.ownerDocument
  const heading = document.createElement('h1')
  heading.textContent = document.title
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'counter'
  root.replaceChildren(heading, button)
  return createCounter(button)
}
