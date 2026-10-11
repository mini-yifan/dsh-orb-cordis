/**
 * koffi, loaded from the copy the Orb host names in `DSH_ORB_KOFFI_DIR`, outside the
 * installed package: on Windows a loaded addon inside the package blocks the next
 * update from replacing it. Without that copy, koffi resolves beside this file.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/koffi
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

type Koffi = typeof import('koffi')

function requireKoffi(): Koffi {
  const dir = process.env.DSH_ORB_KOFFI_DIR
  if (dir !== undefined && dir !== '') {
    try {
      return createRequire(join(dir, 'index.js'))('koffi') as Koffi
    } catch {
      // A copy that does not load: the packaged one still works, it only blocks updates.
    }
  }
  return createRequire(import.meta.url)('koffi') as Koffi
}

const koffi: Koffi = requireKoffi()

export default koffi
