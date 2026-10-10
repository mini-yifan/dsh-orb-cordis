import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { selectAppWindow } from '../src/app-match.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

describe('open_app window matching', () => {
  it('prefers an exact process match over a title match', () => {
    // "source code review" contains "code", but Code.exe is what the model meant.
    const windows = [
      { appName: 'chrome', title: 'source code review' },
      { appName: 'Code', title: 'main.rs' },
    ]
    expect(selectAppWindow(windows, 'code')).toBe(1)
  })

  it('requires a word boundary when a title starts with the name', () => {
    expect(selectAppWindow([{ appName: 'notepad', title: 'Codex' }], 'code')).toBeUndefined()
    expect(selectAppWindow([{ appName: 'notepad', title: 'Notepad' }], 'note')).toBeUndefined()
    expect(selectAppWindow([{ appName: 'notepad', title: 'Code - main.rs' }], 'code')).toBe(0)
  })

  it('matches a whole title and a process base name without .exe', () => {
    expect(selectAppWindow([{ appName: 'Code', title: 'anything' }], 'code')).toBe(0)
    expect(selectAppWindow([{ appName: 'chrome', title: 'Word' }], 'word')).toBe(0)
  })

  it('ignores an empty name and keeps z-order inside each pass', () => {
    const windows = [
      { appName: 'chrome', title: 'Code' },
      { appName: 'Code', title: 'main.rs' },
      { appName: 'Code', title: 'other.rs' },
    ]
    expect(selectAppWindow(windows, '   ')).toBeUndefined()
    // The earlier title match loses to the process match behind it.
    expect(selectAppWindow(windows, 'code')).toBe(1)
  })

  it('is what activateApp resolves names with, never a substring title match', () => {
    // windows-native.ts loads koffi at module scope, so the wiring is pinned from source.
    const native = readFileSync(join(here, '../src/windows-native.ts'), 'utf8')
    expect(native).toMatch(/selectAppWindow\(/)
    expect(native).not.toMatch(/title\.includes\(/)
  })
})
