const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshOrb', {
  /**
   * Ask for a move. `grab` is where inside the dragged element the cursor is holding it.
   *
   * It is what lets the helper place the ball from its OWN absolute cursor reading: the
   * `x`/`y` here are window-relative, so during a drag they are measured against the very
   * window the drag is moving. Feeding those back moves the ball about half the distance,
   * because each move also shifts the frame the next one is measured in.
   */
  move(x, y, canDock, grab) {
    return ipcRenderer.invoke('orb:move', { x, y, canDock: canDock !== false, grab })
  },
  clamp(canDock, origin, grab) {
    return ipcRenderer.invoke('orb:clamp', { canDock: canDock !== false, origin, grab })
  },
  origin() {
    return ipcRenderer.invoke('orb:origin')
  },
  unsnap() {
    return ipcRenderer.invoke('orb:unsnap')
  },
  setExpanded(expanded) {
    return ipcRenderer.invoke('orb:expand', Boolean(expanded))
  },
  /**
   * Report whether the pointer sits on interactive chrome (the ball or the open
   * panel). The window keeps the panel size while collapsed so its origin never
   * moves; the rest of that rectangle is transparent and must be forwarded to the
   * window underneath instead of swallowing its clicks.
   */
  setInteractive(interactive) {
    ipcRenderer.send('orb:interactive', Boolean(interactive))
  },
  /**
   * Report a ball drag starting or ending.
   *
   * The helper cannot infer this: it moves the window through an async channel, so
   * during a drag its picture of the ball is one round-trip behind the cursor. It has
   * to be told, or a fast drag tests the cursor against a stale rectangle, turns the
   * window click-through, and the pointer events the drag is made of stop arriving.
   */
  setDragging(dragging) {
    ipcRenderer.send('orb:dragging', Boolean(dragging))
  },
  send(text) {
    ipcRenderer.send('orb:prompt', text)
  },
  answerQuestion(id, answers) {
    ipcRenderer.send('orb:question-answer', { id, answers })
  },
  cancelQuestion(id) {
    ipcRenderer.send('orb:question-cancel', id)
  },
  requestHistory() {
    ipcRenderer.send('orb:history')
  },
  openSession(id) {
    ipcRenderer.send('orb:open', id)
  },
  openAgent(id) {
    ipcRenderer.send('orb:agent-open', id)
  },
  newSession() {
    ipcRenderer.send('orb:new')
  },
  setPermission(preset) {
    ipcRenderer.send('orb:permission', preset)
  },
  stop() {
    ipcRenderer.send('orb:stop')
  },
  copy(text) {
    ipcRenderer.send('orb:copy', text)
  },
  openMenu() {
    return ipcRenderer.invoke('orb:menu')
  },
  openExternal(url) {
    ipcRenderer.send('orb:open-external', url)
  },
  tccStatus() {
    return ipcRenderer.invoke('orb:tcc-status')
  },
  openTcc(right) {
    return ipcRenderer.invoke('orb:tcc-open', right)
  },
  /**
   * Send one canonical 16 kHz mono PCM16 WAV recording to the host, which
   * proxies it to the official speech service. Resolves to a result object;
   * a missing service or provider comes back as `{ ok: false, error }`.
   */
  transcribe(audioBase64, audioSeconds) {
    return ipcRenderer.invoke('orb:transcribe', { audioBase64, audioSeconds })
  },
  onBlock(callback) {
    ipcRenderer.on('orb:block', (_event, block) => callback(block))
  },
  onBlockDrop(callback) {
    ipcRenderer.on('orb:block-drop', (_event, key) => callback(key))
  },
  onTurn(callback) {
    ipcRenderer.on('orb:turn', (_event, turn) => callback(turn))
  },
  onStatus(callback) {
    ipcRenderer.on('orb:status', (_event, text) => callback(text))
  },
  onSession(callback) {
    ipcRenderer.on('orb:session', (_event, sessionId) => callback(sessionId))
  },
  onQuestion(callback) {
    ipcRenderer.on('orb:question', (_event, question) => callback(question))
  },
  onQuestionClear(callback) {
    ipcRenderer.on('orb:question-clear', (_event, id) => callback(id))
  },
  onQuestionError(callback) {
    ipcRenderer.on('orb:question-error', (_event, payload) => callback(payload))
  },
  onHistory(callback) {
    ipcRenderer.on('orb:history', (_event, items) => callback(items))
  },
  onAgents(callback) {
    ipcRenderer.on('orb:agents', (_event, items) => callback(items))
  },
  onExpandState(callback) {
    ipcRenderer.on('orb:expand-state', (_event, state) => callback(state))
  },
  onPermission(callback) {
    ipcRenderer.on('orb:permission', (_event, preset) => callback(preset))
  },
  onReset(callback) {
    ipcRenderer.on('orb:reset', () => callback())
  },
  onAvatar(callback) {
    ipcRenderer.on('orb:avatar', (_event, src) => callback(src))
  },
  onAttach(callback) {
    ipcRenderer.on('orb:attach', (_event, text) => callback(text))
  },
  /**
   * The expand direction the helper placed the window for. The renderer needs it
   * before the first paint, because the window is already panel-sized.
   */
  onDirection(callback) {
    ipcRenderer.on('orb:direction', (_event, direction) => callback(direction))
  },
  /**
   * The helper's cursor poll: the pointer reached the ball with the panel closed.
   * The page cannot tell on its own, because the panel-sized window keeps the cursor
   * inside it after the ball is left and `pointerleave` therefore never fires.
   */
  onHoverRequest(callback) {
    ipcRenderer.on('orb:hover', () => callback())
  },
  /** The cursor left both the ball and the open panel; collapse is the page's to schedule. */
  onLeaveRequest(callback) {
    ipcRenderer.on('orb:unhover', () => callback())
  },
  onAppearance(callback) {
    ipcRenderer.on('orb:appearance', (_event, appearance) => callback(appearance))
  },
})
