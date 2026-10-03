/** View policy only: collapsing the helper never stops the host session. */
export function canAutoCollapse({ expanded, pinned, running, asking, dragging, pointerInside, composing }) {
  return expanded && !pinned && !running && !asking && !dragging && !pointerInside && !composing
}

export function panelControlAction({ running, asking }) {
  return running || asking ? 'minimize' : 'pin'
}
