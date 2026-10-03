/**
 * Synthetic HID on Linux: an absolute pointer and a keyboard built on
 * `/dev/uinput`.
 *
 * Wayland exposes no input-injection protocol to ordinary clients, so events are
 * posted below the compositor instead: KWin reads them from the kernel exactly
 * like a real device. The pointer is absolute and its axis range is the
 * compositor's virtual desktop rectangle, which makes a logical coordinate map
 * one-to-one onto the pointer position (verified against KWin 6.7).
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/uinput
 */

import koffi from 'koffi'
import { closeSync, openSync } from 'node:fs'
import type { KWinRect } from './kwin.ts'
import { isModifier, keyCode } from './keymap.ts'

/** Error raised when the process may not open `/dev/uinput`. */
export const UINPUT_PERMISSION_MESSAGE =
  'computer-use: /dev/uinput is not accessible. Install the udev rule and group that grant the desktop user access (see docs/05-linux-kde.md).'

/** One synthetic pointer plus keyboard, reused for the life of the process. */
export interface InputDevices {
  /**
   * Make sure both devices exist and the pointer axes cover `desktop`.
   * The pointer is rebuilt when the compositor's desktop rectangle changes.
   * @param desktop - virtual desktop rectangle in logical coordinates.
   */
  prepare(desktop: KWinRect): Promise<void>
  /**
   * Move the pointer to a logical desktop coordinate.
   * @param x - absolute logical x.
   * @param y - absolute logical y.
   */
  moveTo(x: number, y: number): void
  /**
   * Press and release one button at the current pointer position.
   * @param button - which button to click.
   * @param count - 1 for a single click, 2 for a double click.
   */
  click(button: 'left' | 'right' | 'middle', count: 1 | 2): void
  /**
   * Hold one button down without releasing it, for drags and long presses.
   * @param button - which button to hold.
   */
  press(button: 'left' | 'right' | 'middle'): void
  /**
   * Release a button held by {@link InputDevices.press}.
   * @param button - which button to release.
   */
  release(button: 'left' | 'right' | 'middle'): void
  /**
   * Scroll the wheel at the current pointer position.
   * @param direction - wheel direction.
   * @param notches - number of wheel notches to post.
   */
  scroll(direction: 'up' | 'down', notches: number): void
  /**
   * Hold modifier keys down, run `body`, then release them in reverse order.
   * @param tokens - key names accepted by {@link keyCode}.
   * @param body - the action performed while the keys are held.
   */
  chord(tokens: readonly string[], body: () => void | Promise<void>): Promise<void>
  /**
   * Press one key, hold it, and release it.
   * @param token - key name accepted by {@link keyCode}.
   * @param holdMs - how long to hold the key down.
   */
  tap(token: string, holdMs: number): Promise<void>
  /** Release both devices. */
  dispose(): void
}

/** A `/dev/uinput` device kept open for the life of the process. */
interface Device {
  readonly fd: number
}

const EV_SYN = 0x00
const EV_KEY = 0x01
const EV_REL = 0x02
const EV_ABS = 0x03
const SYN_REPORT = 0
const ABS_X = 0x00
const ABS_Y = 0x01
const REL_WHEEL = 0x08
const REL_HWHEEL = 0x06
const BTN_LEFT = 0x110
const BTN_RIGHT = 0x111
const BTN_MIDDLE = 0x112

const BUTTON_CODES: Readonly<Record<'left' | 'right' | 'middle', number>> = {
  left: BTN_LEFT,
  right: BTN_RIGHT,
  middle: BTN_MIDDLE,
}

const O_WRONLY = 0x1
const O_NONBLOCK = 0o4000
/** Highest key code registered on the keyboard device; covers a full PC layout. */
const KEYBOARD_KEY_LIMIT = 248
/** Device creation is asynchronous in the compositor; settle before the first event. */
const DEVICE_SETTLE_MS = 550

interface AbsInfo {
  value: number
  minimum: number
  maximum: number
  fuzz: number
  flat: number
  resolution: number
}

interface AbsSetup {
  code: number
  pad: number
  absinfo: AbsInfo
}

interface DevSetup {
  id: { bustype: number; vendor: number; product: number; version: number }
  name: Buffer
  ff_effects_max: number
}

interface NativeApi {
  readonly close: (fd: number) => number
  readonly write: (fd: number, buffer: Buffer, count: number) => number
  readonly openPointer: (width: number, height: number) => Device
  readonly openKeyboard: () => Device
}

let native: NativeApi | undefined

function api(): NativeApi {
  native ??= buildNativeApi()
  return native
}

function buildNativeApi(): NativeApi {
  const libc = koffi.load('libc.so.6')
  koffi.struct('dsh_orb_input_absinfo', {
    value: 'int32', minimum: 'int32', maximum: 'int32',
    fuzz: 'int32', flat: 'int32', resolution: 'int32',
  })
  koffi.struct('dsh_orb_uinput_abs_setup', {
    code: 'uint16', pad: 'uint16', absinfo: 'dsh_orb_input_absinfo',
  })
  koffi.struct('dsh_orb_input_id', {
    bustype: 'uint16', vendor: 'uint16', product: 'uint16', version: 'uint16',
  })
  koffi.struct('dsh_orb_uinput_setup', {
    id: 'dsh_orb_input_id', name: koffi.array('uint8', 80), ff_effects_max: 'uint32',
  })
  const open = libc.func('int open(const char *pathname, int flags)')
  const close = libc.func('int close(int fd)')
  const ioctlInt = libc.func('int ioctl(int fd, ulong request, int arg)')
  const ioctlAbsSetup = libc.func('int ioctl(int fd, ulong request, dsh_orb_uinput_abs_setup *arg)')
  const ioctlDevSetup = libc.func('int ioctl(int fd, ulong request, dsh_orb_uinput_setup *arg)')
  const write = libc.func('long write(int fd, const void *buf, ulong count)')

  const iow = (nr: number, size: number): number =>
    (1 << 30) | (size << 16) | ('U'.charCodeAt(0) << 8) | nr
  const io = (nr: number): number => ('U'.charCodeAt(0) << 8) | nr
  const UI_DEV_CREATE = io(1)
  const UI_DEV_SETUP = iow(3, koffi.sizeof('dsh_orb_uinput_setup'))
  const UI_ABS_SETUP = iow(4, koffi.sizeof('dsh_orb_uinput_abs_setup'))
  const UI_SET_EVBIT = iow(100, 4)
  const UI_SET_KEYBIT = iow(101, 4)
  const UI_SET_RELBIT = iow(102, 4)
  const UI_SET_ABSBIT = iow(103, 4)

  const must = (result: number, what: string): void => {
    if (result < 0) throw new Error(`computer-use: uinput ${what} failed (${result})`)
  }

  const openDevice = (): number => {
    const fd = open('/dev/uinput', O_WRONLY | O_NONBLOCK)
    if (fd < 0) throw new Error(UINPUT_PERMISSION_MESSAGE)
    return fd
  }

  const label = (text: string): Buffer => {
    const buffer = Buffer.alloc(80)
    buffer.write(text, 0, 'utf8')
    return buffer
  }

  const axis = (fd: number, code: number, maximum: number): void => {
    must(ioctlInt(fd, UI_SET_ABSBIT, code), 'ABS bit')
    must(ioctlAbsSetup(fd, UI_ABS_SETUP, {
      code, pad: 0,
      absinfo: { value: 0, minimum: 0, maximum, fuzz: 0, flat: 0, resolution: 0 },
    }), 'ABS setup')
  }

  const finalize = (fd: number, name: string, product: number): Device => {
    must(ioctlDevSetup(fd, UI_DEV_SETUP, {
      id: { bustype: 0x03, vendor: 0x1, product, version: 1 },
      name: label(name),
      ff_effects_max: 0,
    }), 'DEV setup')
    must(ioctlInt(fd, UI_DEV_CREATE, 0), 'DEV create')
    return { fd }
  }

  return {
    close,
    write,
    openPointer(width, height): Device {
      const fd = openDevice()
      must(ioctlInt(fd, UI_SET_EVBIT, EV_KEY), 'EV_KEY')
      must(ioctlInt(fd, UI_SET_EVBIT, EV_SYN), 'EV_SYN')
      must(ioctlInt(fd, UI_SET_EVBIT, EV_REL), 'EV_REL')
      must(ioctlInt(fd, UI_SET_EVBIT, EV_ABS), 'EV_ABS')
      for (const code of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) must(ioctlInt(fd, UI_SET_KEYBIT, code), 'BTN bit')
      for (const code of [REL_WHEEL, REL_HWHEEL]) must(ioctlInt(fd, UI_SET_RELBIT, code), 'REL bit')
      axis(fd, ABS_X, Math.max(1, Math.round(width)))
      axis(fd, ABS_Y, Math.max(1, Math.round(height)))
      return finalize(fd, 'dsh-orb pointer', 0x1)
    },
    openKeyboard(): Device {
      const fd = openDevice()
      must(ioctlInt(fd, UI_SET_EVBIT, EV_KEY), 'EV_KEY')
      must(ioctlInt(fd, UI_SET_EVBIT, EV_SYN), 'EV_SYN')
      for (let code = 1; code <= KEYBOARD_KEY_LIMIT; code += 1) {
        must(ioctlInt(fd, UI_SET_KEYBIT, code), `KEY bit ${code}`)
      }
      return finalize(fd, 'dsh-orb keyboard', 0x2)
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Create the input device pair.
 * Devices open on first use, so a host without `/dev/uinput` fails at the first
 * GUI action with {@link UINPUT_PERMISSION_MESSAGE} rather than at plugin load.
 * @returns the device pair; call {@link InputDevices.dispose} to release it.
 */
export function createInputDevices(): InputDevices {
  let pointer: Device | undefined
  let keyboard: Device | undefined
  let range = { width: 0, height: 0 }
  let origin = { x: 0, y: 0 }

  function release(device: Device | undefined): void {
    if (device === undefined) return
    try {
      api().close(device.fd)
    } catch {
      // The device is already gone; there is nothing left to release.
    }
  }

  function emit(fd: number, type: number, code: number, value: number): void {
    const buffer = Buffer.alloc(24)
    buffer.writeUInt16LE(type, 16)
    buffer.writeUInt16LE(code, 18)
    buffer.writeInt32LE(value, 20)
    const written = api().write(fd, buffer, 24)
    if (written !== 24) throw new Error(`computer-use: uinput write returned ${written}`)
  }

  function sync(fd: number): void {
    emit(fd, EV_SYN, SYN_REPORT, 0)
  }

  function pointerDevice(): Device {
    if (pointer === undefined) throw new Error('computer-use: pointer device is not prepared')
    return pointer
  }

  function keyboardDevice(): Device {
    if (keyboard === undefined) throw new Error('computer-use: keyboard device is not prepared')
    return keyboard
  }

  function clamp(value: number, maximum: number): number {
    return Math.min(Math.max(Math.round(value - origin.x) , 0), maximum)
  }

  function clampY(value: number, maximum: number): number {
    return Math.min(Math.max(Math.round(value - origin.y), 0), maximum)
  }

  return {
    async prepare(desktop: KWinRect): Promise<void> {
      const width = Math.max(1, Math.round(desktop.width))
      const height = Math.max(1, Math.round(desktop.height))
      origin = { x: desktop.x, y: desktop.y }
      keyboard ??= api().openKeyboard()
      if (pointer !== undefined && range.width === width && range.height === height) return
      release(pointer)
      pointer = api().openPointer(width, height)
      range = { width, height }
      await sleep(DEVICE_SETTLE_MS)
    },
    moveTo(x: number, y: number): void {
      const device = pointerDevice()
      emit(device.fd, EV_ABS, ABS_X, clamp(x, range.width))
      emit(device.fd, EV_ABS, ABS_Y, clampY(y, range.height))
      sync(device.fd)
    },
    click(button: 'left' | 'right' | 'middle', count: 1 | 2): void {
      const device = pointerDevice()
      const code = BUTTON_CODES[button]
      for (let index = 0; index < count; index += 1) {
        emit(device.fd, EV_KEY, code, 1)
        sync(device.fd)
        emit(device.fd, EV_KEY, code, 0)
        sync(device.fd)
      }
    },
    press(button: 'left' | 'right' | 'middle'): void {
      const device = pointerDevice()
      emit(device.fd, EV_KEY, BUTTON_CODES[button], 1)
      sync(device.fd)
    },
    release(button: 'left' | 'right' | 'middle'): void {
      const device = pointerDevice()
      emit(device.fd, EV_KEY, BUTTON_CODES[button], 0)
      sync(device.fd)
    },
    scroll(direction: 'up' | 'down', notches: number): void {
      const device = pointerDevice()
      const value = direction === 'up' ? 1 : -1
      for (let index = 0; index < notches; index += 1) {
        emit(device.fd, EV_REL, REL_WHEEL, value)
        sync(device.fd)
      }
    },
    async chord(tokens: readonly string[], body: () => void | Promise<void>): Promise<void> {
      const device = keyboardDevice()
      const held: number[] = []
      for (const token of tokens) {
        const code = keyCode(token)
        if (code === 0 || !isModifier(code)) continue
        held.push(code)
        emit(device.fd, EV_KEY, code, 1)
      }
      if (held.length > 0) sync(device.fd)
      try {
        await body()
      } finally {
        for (const code of [...held].reverse()) emit(device.fd, EV_KEY, code, 0)
        if (held.length > 0) sync(device.fd)
      }
    },
    async tap(token: string, holdMs: number): Promise<void> {
      const device = keyboardDevice()
      const code = keyCode(token)
      if (code === 0) return
      emit(device.fd, EV_KEY, code, 1)
      sync(device.fd)
      await sleep(holdMs)
      emit(device.fd, EV_KEY, code, 0)
      sync(device.fd)
    },
    dispose(): void {
      release(pointer)
      release(keyboard)
      pointer = undefined
      keyboard = undefined
      range = { width: 0, height: 0 }
    },
  }
}

/**
 * True when this process may open `/dev/uinput` for writing.
 * @returns whether synthetic HID is available.
 */
export function uinputAvailable(): boolean {
  try {
    closeSync(openSync('/dev/uinput', 'w'))
    return true
  } catch {
    return false
  }
}
