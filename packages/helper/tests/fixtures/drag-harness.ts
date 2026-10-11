import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { FloatingPlacement } from '../../src/geometry.ts'

const main = ts.createSourceFile('main.ts', readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)

/** Real main-process callbacks with a mocked OS cursor; no Electron or desktop. */
export function dragHandlers(window: { isDestroyed(): boolean; webContents: { send(channel: string, state: unknown): void } }, placement: FloatingPlacement) {
  let cursor = { x: 0, y: 0 }
  const functions = main.statements.filter(ts.isFunctionDeclaration)
    .filter((node) => node.name?.text === 'cursorPoint' || node.name?.text === 'fromBall')
    .map((node) => node.getText(main)).join('\n')
  const callbacks = new Map<string, (event: unknown, canDock?: unknown) => unknown>()
  for (const node of main.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
    const call = node.expression
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(main) !== 'ipcMain') continue
    if (!ts.isStringLiteral(call.arguments[0]!) || !call.arguments[0].text.startsWith('orb:drag-')) continue
    const compiled = ts.transpileModule(`${functions}\nmodule.exports = ${call.arguments[1]!.getText(main)}`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: undefined as unknown }
    runInNewContext(compiled, { module, win: window, placement,
      screen: { getCursorScreenPoint: () => cursor }, logDockDiagnostics() {} })
    callbacks.set(call.arguments[0].text, module.exports as (event: unknown, canDock?: unknown) => unknown)
  }
  return {
    cursor(point: { x: number; y: number }) { cursor = point },
    invoke(channel: string, event: unknown, argument?: unknown) {
      const callback = callbacks.get(channel)
      assert.ok(callback, channel)
      return callback(event, argument)
    },
  }
}
