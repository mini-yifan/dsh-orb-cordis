import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

/// In-process selection monitor for the Host process.
/// Host is Node on the main thread and does not run a Cocoa loop, so events arrive on a
/// private CFRunLoop via a listen-only CGEventTap. This file must not change the activation policy.

private let minDragPixels: CGFloat = 8
private let readDelayNs: UInt64 = 100_000_000
private let clipboardWaitNs: UInt64 = 20_000_000
private let clipboardDeadlineNs: UInt64 = 150_000_000
private let vkAnsiC: CGKeyCode = 8

private func selectionEventCallback(
  _ proxy: CGEventTapProxy,
  _ type: CGEventType,
  _ event: CGEvent,
  _ userInfo: UnsafeMutableRawPointer?,
) -> Unmanaged<CGEvent>? {
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let userInfo {
      let monitor = Unmanaged<SelectionMonitor>.fromOpaque(userInfo).takeUnretainedValue()
      if let tap = monitor.eventTap {
        CGEvent.tapEnable(tap: tap, enable: true)
      }
    }
    return Unmanaged.passUnretained(event)
  }
  if let userInfo {
    let monitor = Unmanaged<SelectionMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    monitor.handle(type: type, event: event)
  }
  return Unmanaged.passUnretained(event)
}

private final class SelectionMonitor: @unchecked Sendable {
  private let lock = NSLock()
  private var excludePids: Set<pid_t> = [pid_t(getpid())]
  private var press: CGPoint?
  private var dragged = false
  private var frontPid: pid_t = 0
  private var postedCommandCRemaining = 0
  private var readFd: Int32 = -1
  private var writeFd: Int32 = -1
  private var thread: Thread?
  private var runLoop: CFRunLoop?
  fileprivate var eventTap: CFMachPort?
  private var stopping = false

  func outputReadFd() -> Int32 {
    lock.lock()
    let fd = readFd
    lock.unlock()
    return fd
  }

  func start() {
    lock.lock()
    if thread != nil {
      lock.unlock()
      return
    }
    var fds = [Int32](repeating: 0, count: 2)
    guard pipe(&fds) == 0 else {
      lock.unlock()
      emit(["type": "untrusted"])
      return
    }
    readFd = fds[0]
    writeFd = fds[1]
    _ = fcntl(readFd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(writeFd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(writeFd, F_SETFL, O_NONBLOCK)
    stopping = false
    let started = Thread { [weak self] in
      self?.run()
    }
    started.name = "dsh-orb-selection"
    thread = started
    lock.unlock()
    started.start()
  }

  func stop() {
    lock.lock()
    stopping = true
    let loop = runLoop
    let tap = eventTap
    let write = writeFd
    writeFd = -1
    lock.unlock()
    if let tap {
      CGEvent.tapEnable(tap: tap, enable: false)
    }
    if let loop {
      CFRunLoopStop(loop)
    }
    if write >= 0 {
      close(write)
    }
    lock.lock()
    thread = nil
    eventTap = nil
    runLoop = nil
    readFd = -1
    lock.unlock()
    press = nil
    dragged = false
  }

  func lastFrontPid() -> pid_t {
    lock.lock()
    let pid = frontPid
    let excluded = excludePids
    lock.unlock()
    if pid <= 0 || excluded.contains(pid) { return 0 }
    return pid
  }

  func setExcludePids(_ pids: Set<pid_t>) {
    lock.lock()
    excludePids = pids
    lock.unlock()
  }

  func activatePid(_ pid: pid_t) {
    lock.lock()
    let excluded = excludePids
    lock.unlock()
    if excluded.contains(pid) { return }
    guard let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated else {
      return
    }
    if #available(macOS 14.0, *) {
      _ = application.activate()
    } else {
      _ = application.activate(options: [.activateIgnoringOtherApps])
    }
  }

  private func run() {
    let trusted = AXIsProcessTrustedWithOptions([
      kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false,
    ] as CFDictionary)
    rememberFront(NSWorkspace.shared.frontmostApplication)
    let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
      self?.rememberFront(NSWorkspace.shared.frontmostApplication)
    }
    RunLoop.current.add(timer, forMode: .common)
    if !trusted {
      emit(["type": "untrusted"])
      emit(["type": "ready"])
      lock.lock()
      runLoop = CFRunLoopGetCurrent()
      let shouldStop = stopping
      lock.unlock()
      if !shouldStop {
        CFRunLoopRun()
      }
      timer.invalidate()
      return
    }
    let mask = eventMask()
    let userInfo = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: selectionEventCallback,
      userInfo: userInfo,
    ) else {
      emit(["type": "untrusted"])
      emit(["type": "ready"])
      lock.lock()
      runLoop = CFRunLoopGetCurrent()
      let shouldStop = stopping
      lock.unlock()
      if !shouldStop { CFRunLoopRun() }
      timer.invalidate()
      return
    }
    lock.lock()
    eventTap = tap
    runLoop = CFRunLoopGetCurrent()
    let shouldStop = stopping
    lock.unlock()
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit(["type": "ready"])
    if !shouldStop {
      CFRunLoopRun()
    }
    timer.invalidate()
    CGEvent.tapEnable(tap: tap, enable: false)
  }

  private func eventMask() -> CGEventMask {
    let types: [CGEventType] = [
      .leftMouseDown, .leftMouseUp, .leftMouseDragged,
      .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown,
    ]
    return types.reduce(0) { mask, type in
      mask | (CGEventMask(1) << type.rawValue)
    }
  }

  fileprivate func handle(type: CGEventType, event: CGEvent) {
    let location = event.location
    let point = (x: Double(location.x), y: Double(location.y))
    switch type {
    case .leftMouseDown:
      press = location
      dragged = false
      emit(["type": "mouse-down", "x": point.x, "y": point.y])
    case .leftMouseDragged:
      if let origin = press {
        let dx = location.x - origin.x
        let dy = location.y - origin.y
        if hypot(dx, dy) >= minDragPixels { dragged = true }
      }
    case .leftMouseUp:
      // A double- or triple-click selects a word or paragraph without moving the pointer,
      // so the click count counts as a selection too; a lone click still reads nothing.
      let clickCount = event.getIntegerValueField(.mouseEventClickState)
      let shouldRead = press != nil && (dragged || clickCount >= 2)
      press = nil
      dragged = false
      emit(["type": "mouse-up", "x": point.x, "y": point.y])
      if shouldRead {
        DispatchQueue.global(qos: .userInitiated).async {
          self.readSelection(anchor: point)
        }
      }
    case .rightMouseDown, .otherMouseDown:
      emit(["type": "dismiss"])
    case .scrollWheel:
      if event.getIntegerValueField(.scrollWheelEventMomentumPhase) != 0 { return }
      let dx = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2)
      let dy = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
      if dx == 0 && dy == 0 { return }
      emit(["type": "dismiss"])
    case .keyDown:
      if consumePostedCommandC(event) { return }
      emit(["type": "key"])
    default:
      break
    }
  }

  private func rememberFront(_ application: NSRunningApplication?) {
    guard let pid = application?.processIdentifier, pid > 0 else { return }
    lock.lock()
    if !excludePids.contains(pid) {
      frontPid = pid
    }
    lock.unlock()
  }

  private func notePostedCommandC() {
    lock.lock()
    postedCommandCRemaining += 1
    lock.unlock()
  }

  private func consumePostedCommandC(_ event: CGEvent) -> Bool {
    let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    guard keyCode == vkAnsiC, event.flags.contains(.maskCommand) else { return false }
    lock.lock()
    defer { lock.unlock() }
    guard postedCommandCRemaining > 0 else { return false }
    postedCommandCRemaining -= 1
    return true
  }

  private func readSelection(anchor: (x: Double, y: Double)) {
    usleep(useconds_t(readDelayNs / 1_000))
    lock.lock()
    let excluded = excludePids
    lock.unlock()
    let front = NSWorkspace.shared.frontmostApplication
    if let pid = front?.processIdentifier, excluded.contains(pid) { return }
    if let ax = readAccessibility() {
      emitSelection(
        text: ax.text,
        bounds: ax.bounds,
        pid: front?.processIdentifier,
        bundle: front?.bundleIdentifier,
        x: anchor.x,
        y: anchor.y,
      )
      return
    }
    if let text = readClipboardFallback(onPostCommandC: { self.notePostedCommandC() }) {
      emitSelection(
        text: text,
        bounds: nil,
        pid: front?.processIdentifier,
        bundle: front?.bundleIdentifier,
        x: anchor.x,
        y: anchor.y,
      )
    }
  }

  private func emitSelection(
    text: String,
    bounds: CGRect?,
    pid: pid_t?,
    bundle: String?,
    x: Double? = nil,
    y: Double? = nil,
  ) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return }
    var payload: [String: Any] = ["type": "selection", "text": trimmed]
    if let pid { payload["pid"] = Int(pid) }
    if let bundle { payload["bundle"] = bundle }
    if let bounds { payload["bounds"] = electronRect(bounds) }
    if let x { payload["x"] = x }
    if let y { payload["y"] = y }
    emit(payload)
  }

  private func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
      let data = try? JSONSerialization.data(withJSONObject: payload),
      var line = String(data: data, encoding: .utf8)
    else { return }
    line += "\n"
    lock.lock()
    let fd = writeFd
    let emitC = libraryEmit.emit
    let context = libraryEmit.context
    lock.unlock()
    if fd >= 0 {
      line.withCString { pointer in
        _ = Darwin.write(fd, pointer, strlen(pointer))
      }
    }
    if let emitC {
      line.dropLast().withCString { emitC($0, context) }
    }
  }
}

private func readAccessibility() -> (text: String, bounds: CGRect?)? {
  let system = AXUIElementCreateSystemWide()
  var focused: CFTypeRef?
  let focusedError = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused)
  guard focusedError == .success, let element = focused else { return nil }
  var selected: CFTypeRef?
  let selectedError = AXUIElementCopyAttributeValue(
    (element as! AXUIElement),
    kAXSelectedTextAttribute as CFString,
    &selected,
  )
  guard selectedError == .success, let text = selected as? String else { return nil }
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { return nil }
  var rangeValue: CFTypeRef?
  let rangeError = AXUIElementCopyAttributeValue(
    (element as! AXUIElement),
    kAXSelectedTextRangeAttribute as CFString,
    &rangeValue,
  )
  var bounds: CGRect?
  if rangeError == .success, let range = rangeValue {
    var cfRange = CFRange()
    if AXValueGetValue(range as! AXValue, .cfRange, &cfRange), cfRange.length <= 0 { return nil }
    var boundsValue: CFTypeRef?
    let boundsError = AXUIElementCopyParameterizedAttributeValue(
      (element as! AXUIElement),
      kAXBoundsForRangeParameterizedAttribute as CFString,
      range,
      &boundsValue,
    )
    if boundsError == .success, let raw = boundsValue {
      var rect = CGRect.zero
      if AXValueGetValue(raw as! AXValue, .cgRect, &rect) { bounds = rect }
    }
  }
  return (trimmed, bounds)
}

private func readClipboardFallback(onPostCommandC: () -> Void) -> String? {
  let pasteboard = NSPasteboard.general
  let previous = pasteboard.string(forType: .string) ?? ""
  let before = previous.trimmingCharacters(in: .whitespacesAndNewlines)
  guard postCommandC(onPost: onPostCommandC) else { return nil }
  let deadline = DispatchTime.now().uptimeNanoseconds + clipboardDeadlineNs
  while DispatchTime.now().uptimeNanoseconds < deadline {
    let current = (pasteboard.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !current.isEmpty && current != before {
      pasteboard.clearContents()
      if !previous.isEmpty { pasteboard.setString(previous, forType: .string) }
      return current
    }
    usleep(useconds_t(clipboardWaitNs / 1_000))
  }
  pasteboard.clearContents()
  if !previous.isEmpty { pasteboard.setString(previous, forType: .string) }
  return nil
}

private func postCommandC(onPost: () -> Void) -> Bool {
  guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: vkAnsiC, keyDown: true),
    let up = CGEvent(keyboardEventSource: source, virtualKey: vkAnsiC, keyDown: false)
  else { return false }
  down.flags = .maskCommand
  up.flags = .maskCommand
  onPost()
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
  return true
}

private func electronPoint(_ cocoa: NSPoint) -> (x: Double, y: Double) {
  let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main
  let maxY = primary?.frame.maxY ?? cocoa.y
  return (Double(cocoa.x), Double(maxY - cocoa.y))
}

private func electronRect(_ cocoa: CGRect) -> [String: Double] {
  let topLeft = electronPoint(NSPoint(x: cocoa.origin.x, y: cocoa.maxY))
  return [
    "x": topLeft.x,
    "y": topLeft.y,
    "width": Double(cocoa.size.width),
    "height": Double(cocoa.size.height),
  ]
}

public typealias DshSelectionEmit = @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void

private final class LibraryEmit: @unchecked Sendable {
  let lock = NSLock()
  var emit: DshSelectionEmit?
  var context: UnsafeMutableRawPointer?
}

private let libraryEmit = LibraryEmit()
private var libraryMonitor: SelectionMonitor?

@_cdecl("dsh_macos_selection_start")
public func dsh_macos_selection_start(
  callback: DshSelectionEmit?,
  context: UnsafeMutableRawPointer?,
) -> Int32 {
  libraryEmit.lock.lock()
  libraryEmit.emit = callback
  libraryEmit.context = context
  libraryEmit.lock.unlock()
  if libraryMonitor == nil { libraryMonitor = SelectionMonitor() }
  libraryMonitor?.start()
  return 0
}

@_cdecl("dsh_macos_selection_read_fd")
public func dsh_macos_selection_read_fd() -> Int32 {
  libraryMonitor?.outputReadFd() ?? -1
}

@_cdecl("dsh_macos_selection_stop")
public func dsh_macos_selection_stop() {
  libraryMonitor?.stop()
  libraryMonitor = nil
  libraryEmit.lock.lock()
  libraryEmit.emit = nil
  libraryEmit.context = nil
  libraryEmit.lock.unlock()
}

@_cdecl("dsh_macos_selection_exclude_pids")
public func dsh_macos_selection_exclude_pids(_ pids: UnsafePointer<CChar>?) {
  var next: Set<pid_t> = [pid_t(getpid())]
  if let pids {
    for part in String(cString: pids).split(separator: ",") {
      if let value = Int32(part.trimmingCharacters(in: .whitespaces)) {
        next.insert(pid_t(value))
      }
    }
  }
  libraryMonitor?.setExcludePids(next)
}

@_cdecl("dsh_macos_selection_activate_pid")
public func dsh_macos_selection_activate_pid(_ pid: Int32) {
  libraryMonitor?.activatePid(pid_t(pid))
}

@_cdecl("dsh_macos_selection_last_front_pid")
public func dsh_macos_selection_last_front_pid() -> Int32 {
  libraryMonitor?.lastFrontPid() ?? 0
}

@_cdecl("dsh_macos_selection_prompt")
public func dsh_macos_selection_prompt() -> Int32 {
  let trusted = AXIsProcessTrustedWithOptions([
    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
  ] as CFDictionary)
  return trusted ? 1 : 0
}

@_cdecl("dsh_macos_selection_trusted")
public func dsh_macos_selection_trusted() -> Int32 {
  AXIsProcessTrusted() ? 1 : 0
}
