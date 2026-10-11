/** Translate one Windows hook message into toolbar events. A left mouse-up reads the selection. */
export function dispatchWindowsSelectionMessage(message, handlers, probe, excluded, reads = { generation: 0 }) {
  if (message.type === 'key' || message.type === 'wheel') {
    handlers.onEvent({ type: message.type === 'key' ? 'key' : 'dismiss' })
    return
  }
  if (message.button !== 'left') {
    handlers.onEvent({ type: 'dismiss' })
    return
  }
  // The read is a slow PowerShell round trip. A newer press or release makes this one stale:
  // its result must not pop the toolbar back up after the click that dismissed it.
  if (message.type === 'mouse-down' || message.type === 'mouse-up') reads.generation += 1
  handlers.onEvent({ type: message.type, x: message.x, y: message.y })
  if (message.type !== 'mouse-up') return
  const generation = reads.generation
  void probe.readSelection().then((selection) => {
    if (generation !== reads.generation) return
    if (selection === undefined || selection.text.trim() === '') return
    if (selection.pid !== undefined && excluded.has(selection.pid)) return
    handlers.onEvent({
      type: 'selection',
      text: selection.text,
      ...selection.pid === undefined ? {} : { pid: selection.pid },
      ...selection.x === undefined || selection.y === undefined ? {} : { x: selection.x, y: selection.y },
      ...selection.x === undefined || selection.y === undefined
        || selection.width === undefined || selection.height === undefined
        ? {}
        : { bounds: { x: selection.x, y: selection.y, width: selection.width, height: selection.height } },
    })
  }).catch(() => {
    // A failed UI Automation read leaves the toolbar hidden.
  })
}

export function startWindowsSelectionMonitor(handlers, probe, install) {
  const excluded = new Set()
  let lastFront
  const tracking = {
    readSelection: () => probe.readSelection().then((selection) => {
      if (selection?.pid !== undefined && !excluded.has(selection.pid)) lastFront = selection.pid
      return selection
    }),
    activatePid: (pid) => { probe.activatePid(pid) },
  }
  handlers.onEvent({ type: 'ready' })
  let unhook = () => {}
  const reads = { generation: 0 }
  try {
    unhook = install((message) => { dispatchWindowsSelectionMessage(message, handlers, tracking, excluded, reads) })
  } catch (error) {
    console.error(`dsh-orb: selection hook failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    stop() { unhook() },
    setExcludePids(pids) {
      excluded.clear()
      for (const pid of pids) excluded.add(pid)
    },
    activatePid(pid) {
      if (excluded.has(pid)) return
      probe.activatePid(pid)
    },
    lastFrontPid() {
      return lastFront
    },
  }
}
