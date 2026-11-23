(() => {
  const names = window.BOARD_NAMES
  const dialog = document.getElementById(names.drill)
  const content = document.getElementById(names.drillContent)
  const scroller = document.getElementById(names.backlogScroll)
  const view = { filter: '', scroll: 0, open: null, agents: {}, folds: {} }
  let written = document.body.dataset.written
  let period = Number(document.body.dataset.tickMs)
  let due = null
  let pending = 0
  let loading = false
  let shownLoad = 0
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
  const COUNT_MS = 600
  const WRITE_SLACK_MS = 1500
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
    if (stored.folds !== null && typeof stored.folds === 'object')
      view.folds = stored.folds
  }
  catch {}
  let boardFilters = null
  const showFilter = (hash) => {
    const backlog = document.getElementById(names.backlog)
    if (!backlog)
      return
    if (hash && (boardFilters === null || boardFilters.includes(hash.slice(1))))
      backlog.setAttribute(names.filterAttribute, hash.slice(1))
    else
      backlog.removeAttribute(names.filterAttribute)
  }
  showFilter(location.hash || view.filter)
  let hovered = null
  const showDaemon = () => {
    document.querySelectorAll('[data-daemon-pane]').forEach((pane) => {
      if (hovered === null ? pane.hasAttribute('data-default') : pane.dataset.daemonPane === hovered)
        pane.setAttribute('data-shown', '')
      else
        pane.removeAttribute('data-shown')
    })
  }
  const hover = (event) => {
    const slot = event.target.closest && event.target.closest('[data-daemon-slot]')
    const next = slot ? slot.dataset.daemonSlot : null
    if (next === hovered)
      return
    hovered = next
    showDaemon()
  }
  document.addEventListener('mouseover', hover)
  document.addEventListener('focusin', hover)
  const stampFolds = () => {
    document.querySelectorAll('[data-task]').forEach((group) => {
      const task = group.dataset && group.dataset.task
      if (!task)
        return
      const button = group.querySelector && group.querySelector('[data-fold]')
      if (view.folds[task])
        group.removeAttribute('data-collapsed')
      else
        group.setAttribute('data-collapsed', '')
      if (button)
        button.setAttribute('aria-expanded', view.folds[task] ? 'true' : 'false')
    })
  }
  const toggleFold = (task) => {
    if (view.folds[task])
      delete view.folds[task]
    else
      view.folds[task] = true
    stampFolds()
    save()
  }
  const countLoad = () => {
    const counter = document.querySelector && document.querySelector('[data-count]')
    const target = counter ? Number(counter.dataset.count) : Number.NaN
    if (!(target >= 0) || !frame)
      return
    const from = shownLoad
    const started = Date.now()
    const step = () => {
      const share = Math.min(1, (Date.now() - started) / COUNT_MS)
      counter.textContent = (from + (target - from) * (1 - (1 - share) ** 3)).toFixed(1)
      if (share < 1)
        frame(step)
    }
    shownLoad = target
    frame(step)
  }
  const countdown = () => {
    const shown = document.getElementById(names.refreshIn)
    const text = due === null ? '' : ` · next in ${Math.max(0, Math.ceil((due - Date.now()) / 1000))}s`
    if (shown && shown.textContent !== text)
      shown.textContent = text
    frame(countdown)
  }
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
    const fold = event.target.closest && event.target.closest('[data-fold]')
    if (fold) {
      toggleFold(fold.dataset.fold)
      return
    }
    if (event.target.closest && event.target.closest('[data-pull]')) {
      pending += 1
      update()
      return
    }
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
    showFilter(view.filter)
    save()
  })
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      view.scroll = scroller.scrollTop
      save()
    })
  }
  let restored = false
  const restore = () => {
    restored = true
    if (location.hash)
      view.filter = location.hash
    else if (view.filter && document.getElementById(view.filter.slice(1)))
      location.hash = view.filter
    showFilter(view.filter)
    if (scroller)
      scroller.scrollTop = view.scroll
    if (view.open)
      open(view.open)
    stampAgents()
  }
  const shell = written === ''
  if (!shell)
    restore()
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
  const slotReadings = () => {
    const used = {}
    document.querySelectorAll('[data-slot-queue]').forEach((row) => {
      used[row.dataset.slotQueue] = Number(row.dataset.used)
    })
    return used
  }
  const replay = (node, name) => {
    if (typeof node.classList.remove === 'function') {
      node.classList.remove(name)
      void node.offsetWidth
    }
    node.classList.add(name)
  }
  const KEYS = ['id', 'data-card', 'data-agents', 'data-task', 'data-lane', 'data-slot-queue', 'data-family', 'data-event', 'data-node', 'data-cell', 'data-open']
  const keyOf = (node) => {
    if (node.nodeType !== 1)
      return null
    const name = KEYS.find(attribute => node.hasAttribute(attribute))
    return name === undefined ? null : `${node.nodeName}|${name}=${node.getAttribute(name)}`
  }
  const syncAttributes = (node, next) => {
    Array.from(node.attributes).forEach((attribute) => {
      if (!next.hasAttribute(attribute.name))
        node.removeAttribute(attribute.name)
    })
    Array.from(next.attributes).forEach((attribute) => {
      if (node.getAttribute(attribute.name) !== attribute.value)
        node.setAttribute(attribute.name, attribute.value)
    })
  }
  const patchNode = (node, next) => {
    if (node.nodeType !== 1) {
      if (node.nodeValue !== next.nodeValue)
        node.nodeValue = next.nodeValue
      return
    }
    syncAttributes(node, next)
    patchChildren(node, next)
  }
  const reusable = (node, next) => node !== null && node.nodeType === next.nodeType && node.nodeName === next.nodeName && keyOf(node) === null
  function patchChildren(parent, next) {
    const keyed = new Map()
    Array.from(parent.childNodes).forEach((child) => {
      const key = keyOf(child)
      if (key !== null && !keyed.has(key))
        keyed.set(key, child)
    })
    let cursor = parent.firstChild
    Array.from(next.childNodes).forEach((incoming) => {
      const key = keyOf(incoming)
      const match = key === null ? (reusable(cursor, incoming) ? cursor : null) : keyed.get(key) || null
      if (key !== null)
        keyed.delete(key)
      if (match === null) {
        parent.insertBefore(incoming, cursor)
        return
      }
      if (match === cursor)
        cursor = cursor.nextSibling
      else
        parent.insertBefore(match, cursor)
      patchNode(match, incoming)
    })
    while (cursor !== null) {
      const after = cursor.nextSibling
      cursor.remove()
      cursor = after
    }
  }
  const patch = (slot, html) => {
    const template = document.createElement('template')
    template.innerHTML = html
    if (!template.content || !slot.childNodes) {
      slot.innerHTML = html
      return
    }
    patchChildren(slot, template.content)
  }
  const markSlots = (before) => {
    document.querySelectorAll('[data-slot-queue]').forEach((row) => {
      const was = before[row.dataset.slotQueue]
      const now = Number(row.dataset.used)
      if (!(was >= 0) || !(now >= 0) || was === now || !row.querySelectorAll)
        return
      row.querySelectorAll('[data-seg]').forEach((segment, index) => {
        if (index >= was && index < now)
          replay(segment, 'seg-in')
        if (index >= now && index < was)
          replay(segment, 'seg-out')
      })
    })
  }
  const MOTION_MS = 700
  const first = selector => (document.querySelector ? document.querySelector(selector) : null)
  const flowMinute = () => {
    const strip = first('[data-flow-minute]')
    return strip ? Number(strip.dataset.flowMinute) : Number.NaN
  }
  const shiftFlow = (was) => {
    const strip = first('[data-flow-minute]')
    const shift = strip ? Number(strip.dataset.flowMinute) - was : Number.NaN
    if (!(shift > 0) || !strip.querySelectorAll)
      return
    const bars = strip.querySelectorAll('[data-flow-bar]')
    strip.style.setProperty('--_shift', String(Math.min(shift, bars.length)))
    replay(strip, 'flow-shift')
    const newest = bars[bars.length - 1]
    if (newest)
      replay(newest, 'flow-new')
  }
  const familyReadings = () => {
    const ranks = {}
    document.querySelectorAll('[data-family]').forEach((row) => {
      ranks[row.dataset.family] = { rank: Number(row.dataset.rank), share: Number(row.dataset.share), html: row.innerHTML }
    })
    return ranks
  }
  const fadeOut = (was) => {
    const list = first('[data-families]')
    if (!list || !list.appendChild)
      return
    const ghost = document.createElement('li')
    ghost.className = 'rank-out'
    ghost.setAttribute('aria-hidden', 'true')
    ghost.style.setProperty('--_rank', String(was.rank))
    ghost.style.setProperty('--_share', `${was.share}%`)
    ghost.innerHTML = was.html
    list.appendChild(ghost)
    setTimeout(() => ghost.remove(), MOTION_MS)
  }
  const moveFamilies = (before) => {
    const seen = {}
    document.querySelectorAll('[data-family]').forEach((row) => {
      const family = row.dataset.family
      const was = before[family]
      seen[family] = true
      if (!was) {
        replay(row, 'rank-in')
        return
      }
      if (Number(row.dataset.share) > was.share)
        replay(row, 'share-up')
    })
    Object.keys(before).forEach((family) => {
      if (!seen[family])
        fadeOut(before[family])
    })
  }
  const apply = (board) => {
    const before = slotReadings()
    const minute = flowMinute()
    const families = familyReadings()
    document.title = names.titlePrefix + board.written
    Object.keys(board.slots).forEach((name) => {
      const slot = document.getElementById(names.slotPrefix + name)
      if (slot && typeof board.slots[name] === 'string')
        patch(slot, board.slots[name])
    })
    markSlots(before)
    shiftFlow(minute)
    moveFamilies(families)
    const backlog = document.getElementById(names.backlog)
    board.filters.forEach((id) => {
      if (!backlog || typeof id !== 'string' || document.getElementById(id))
        return
      const target = document.createElement('span')
      target.className = 'filter-target'
      target.id = id
      backlog.prepend(target)
    })
    if (Array.isArray(board.filters))
      boardFilters = board.filters
    const icon = names.icon && document.getElementById(names.icon.id)
    if (icon && Array.isArray(board.alarms))
      icon.setAttribute('href', board.alarms.length > 0 ? names.icon.alarm : names.icon.calm)
    stampAgents()
    stampFolds()
    showDaemon()
    countLoad()
    if (restored)
      showFilter(view.filter)
    else
      restore()
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
    if (loading)
      return
    loading = true
    window.BOARD = undefined
    const script = document.createElement('script')
    const settled = () => {
      script.remove()
      loading = false
      schedule()
    }
    script.onload = () => {
      receive(window.BOARD)
      settled()
    }
    script.onerror = () => {
      stale()
      settled()
    }
    script.src = `${names.dataFile}?t=${Date.now()}`
    document.head.appendChild(script)
  }
  const delayFromWritten = () => {
    const left = Date.parse(written) + period + WRITE_SLACK_MS - Date.now()
    return left > 0 && left <= period ? left : period
  }
  function schedule() {
    if (!(period > 0))
      return
    const delay = delayFromWritten()
    pending += 1
    const mine = pending
    due = Date.now() + delay
    setTimeout(() => {
      if (mine === pending)
        update()
    }, delay)
  }
  stampFolds()
  countLoad()
  if (shell)
    update()
  else
    schedule()
  if (frame)
    frame(countdown)
  const round = names.round
  const channels = hex => [1, 3, 5].map(from => Number.parseInt(hex.slice(from, from + 2), 16))
  const mixed = (from, to, share) => {
    const end = channels(to)
    return `#${channels(from).map((channel, index) => Math.round(channel + (end[index] - channel) * share).toString(16).padStart(2, '0')).join('')}`
  }
  const colourOf = (share) => {
    if (share >= 1)
      return round.over
    const bounded = Math.max(0, share)
    return bounded < round.warnShare ? mixed(round.calm, round.warn, bounded / round.warnShare) : mixed(round.warn, round.over, (bounded - round.warnShare) / (1 - round.warnShare))
  }
  const pad = value => String(value).padStart(2, '0')
  const clockOf = (ms) => {
    const whole = Math.max(0, Math.floor(ms))
    return `${pad(Math.floor(whole / 60000))}:${pad(Math.floor(whole % 60000 / 1000))}.${pad(Math.floor(whole % 1000 / 10))}`
  }
  const tickRound = (node, now) => {
    const elapsed = Math.max(0, now - Date.parse(node.dataset.roundStart))
    const expected = Number(node.dataset.roundExpectedMs)
    const clock = node.querySelector('.round-clock')
    const label = node.querySelector('.round-label')
    if (!(expected > 0)) {
      if (clock)
        clock.textContent = clockOf(elapsed)
      return
    }
    const share = elapsed / expected
    const over = share >= 1
    node.setAttribute('data-phase', over ? 'over' : share >= round.warnShare ? 'warn' : 'calm')
    node.style.setProperty('--_round', colourOf(share))
    node.style.setProperty('--_left', `${Math.round(Math.max(0, 1 - share) * 100)}%`)
    if (clock)
      clock.textContent = over ? `+${clockOf(elapsed - expected)}` : clockOf(expected - elapsed)
    if (label)
      label.textContent = over ? round.overTime : round.remaining
  }
  const ticks = () => {
    const now = Date.now()
    document.querySelectorAll('[data-round-start]').forEach((node) => {
      if (node.dataset && node.dataset.roundStart && node.style && node.querySelector)
        tickRound(node, now)
    })
    requestAnimationFrame(ticks)
  }
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(ticks)
})()
