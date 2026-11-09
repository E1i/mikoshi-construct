(() => {
  const names = window.BOARD_NAMES
  const dialog = document.getElementById(names.drill)
  const content = document.getElementById(names.drillContent)
  const scroller = document.getElementById(names.backlogScroll)
  const view = { filter: '', scroll: 0, open: null, agents: {} }
  let written = document.body.dataset.written
  let period = Number(document.body.dataset.tickMs)
  const save = () => {
    try {
      localStorage.setItem(names.viewKey, JSON.stringify(view))
    }
    catch {}
  }
  try {
    const stored = JSON.parse(localStorage.getItem(names.viewKey) || '{}')
    if (typeof stored.filter === 'string')
      view.filter = stored.filter
    if (typeof stored.scroll === 'number')
      view.scroll = stored.scroll
    if (typeof stored.open === 'string')
      view.open = stored.open
    if (stored.agents !== null && typeof stored.agents === 'object')
      view.agents = stored.agents
  }
  catch {}
  const stampAgents = () => {
    const shown = {}
    document.querySelectorAll('[data-agents]').forEach((line) => {
      shown[line.dataset.agents] = true
      line.setAttribute('aria-expanded', view.agents[line.dataset.agents] ? 'true' : 'false')
    })
    Object.keys(view.agents).forEach((session) => {
      if (!shown[session])
        delete view.agents[session]
    })
    save()
  }
  const toggleAgents = (line) => {
    if (view.agents[line.dataset.agents])
      delete view.agents[line.dataset.agents]
    else
      view.agents[line.dataset.agents] = true
    stampAgents()
  }
  const open = (name) => {
    const template = document.getElementById(names.dialogPrefix + name)
    if (!template) {
      view.open = dialog.open ? view.open : null
      return
    }
    content.innerHTML = template.innerHTML
    if (!dialog.open)
      dialog.showModal()
    view.open = name
    save()
  }
  const activates = event => event.key === 'Enter' || event.key === ' '
  dialog.addEventListener('close', () => {
    view.open = null
    save()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog)
      dialog.close()
  })
  document.addEventListener('click', (event) => {
    const line = event.target.closest && event.target.closest('[data-agents]')
    if (line) {
      toggleAgents(line)
      return
    }
    if (event.target.closest && event.target.closest('[data-agents-list]'))
      return
    const hit = event.target.closest && event.target.closest('[data-open]')
    if (hit)
      open(hit.dataset.open)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (dialog.open)
        dialog.close()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey)
      return
    const agents = event.target.closest && event.target.closest('[data-agents]')
    if (agents && activates(event)) {
      event.preventDefault()
      toggleAgents(agents)
      return
    }
    const hit = event.target.closest && event.target.closest('[data-open]')
    if (hit && hit.tagName !== 'BUTTON' && activates(event)) {
      event.preventDefault()
      open(hit.dataset.open)
      return
    }
    if (event.key === 'h' || event.key === 'H')
      open(names.handoffDialog)
    if (event.key === 'd' || event.key === 'D')
      open(names.decisionsDialog)
  })
  addEventListener('hashchange', () => {
    view.filter = location.hash
    save()
  })
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      view.scroll = scroller.scrollTop
      save()
    })
  }
  if (location.hash)
    view.filter = location.hash
  else if (view.filter && document.getElementById(view.filter.slice(1)))
    location.hash = view.filter
  if (scroller)
    scroller.scrollTop = view.scroll
  if (view.open)
    open(view.open)
  stampAgents()
  const stale = () => {
    const live = document.getElementById(names.busLive)
    if (live) {
      live.setAttribute('data-stale', '')
      live.textContent = names.offlineReading
    }
    const pulse = document.getElementById(names.pulse)
    if (pulse)
      pulse.setAttribute('data-stale', '')
  }
  const readable = board => board !== null && typeof board === 'object' && typeof board.written === 'string' && board.slots !== null && typeof board.slots === 'object' && Array.isArray(board.filters)
  const apply = (board) => {
    document.title = names.titlePrefix + board.written
    Object.keys(board.slots).forEach((name) => {
      const slot = document.getElementById(names.slotPrefix + name)
      if (slot && typeof board.slots[name] === 'string')
        slot.innerHTML = board.slots[name]
    })
    const backlog = document.getElementById(names.backlog)
    board.filters.forEach((id) => {
      if (!backlog || typeof id !== 'string' || document.getElementById(id))
        return
      const target = document.createElement('span')
      target.className = 'filter-target'
      target.id = id
      backlog.prepend(target)
    })
    stampAgents()
  }
  const markOld = () => {
    if (!(period > 0 && Date.now() - Date.parse(written) > names.staleTicks * period))
      return
    const live = document.getElementById(names.busLive)
    if (live) {
      live.setAttribute('data-stale', '')
      live.textContent = names.staleReading
    }
  }
  const receive = (board) => {
    if (!readable(board)) {
      stale()
      return
    }
    if (typeof board.tickMs === 'number' && board.tickMs > 0)
      period = board.tickMs
    if (board.written !== written) {
      written = board.written
      apply(board)
    }
    markOld()
  }
  markOld()
  function update() {
    window.BOARD = undefined
    const script = document.createElement('script')
    script.onload = () => {
      script.remove()
      receive(window.BOARD)
      schedule()
    }
    script.onerror = () => {
      script.remove()
      stale()
      schedule()
    }
    script.src = `${names.dataFile}?t=${Date.now()}`
    document.head.appendChild(script)
  }
  function schedule() {
    if (period > 0)
      setTimeout(update, period)
  }
  schedule()
})()
