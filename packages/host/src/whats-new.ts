/**
 * The one release note the settings page shows after installing or upgrading to this build.
 *
 * A note belongs to one exact version. The settings page only offers it when the installed
 * package reports that version, so a later release that forgets to replace this constant does
 * not show a stale note to its users. Each version keeps its own dismissal marker; adding a
 * note for a new release means bumping both this value and the client copy.
 */
export const WHATS_NEW_VERSION = '0.3.1'

/** What the settings page needs to draw the 0.3.1 note; the copy itself lives in the client. */
export interface WhatsNewNotice {
  readonly id: string
  readonly version: string
}

/**
 * Whether the settings page should offer the release note.
 *
 * @param supported - the ball exists on this platform (macOS or Windows).
 * @param currentVersion - the installed bundle's version, empty when the layout is unknown.
 * @param dismissed - the profile already closed this exact note.
 * @returns the note to render, or null when any of the three gates says no.
 */
export function visibleWhatsNew(
  supported: boolean,
  currentVersion: string,
  dismissed: boolean,
): WhatsNewNotice | null {
  if (!supported || currentVersion !== WHATS_NEW_VERSION || dismissed) return null
  return { id: WHATS_NEW_VERSION, version: WHATS_NEW_VERSION }
}
