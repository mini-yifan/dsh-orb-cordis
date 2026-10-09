/**
 * Load koffi from the copy the host names in `DSH_ORB_KOFFI_DIR`, outside the installed
 * package: on Windows a loaded addon inside the package blocks the next update from
 * replacing it. Without that copy, koffi resolves beside this file.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

export function requireKoffi() {
  const dir = process.env.DSH_ORB_KOFFI_DIR
  if (dir) {
    try {
      return createRequire(join(dir, 'index.js'))('koffi')
    } catch {
      // A copy that does not load: the packaged one still works, it only blocks updates.
    }
  }
  return require('koffi')
}
