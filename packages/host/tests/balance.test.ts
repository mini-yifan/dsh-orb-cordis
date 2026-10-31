import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BalanceMonitor,
  compactBalance,
  formatBalance,
  readRechargeBalance,
} from '../src/balance.ts'

describe('recharge balance', () => {
  it('formats the recharge wallet with Platform rules and leaves bonuses out', () => {
    assert.equal(formatBalance(0, '¥'), '¥0.00')
    assert.equal(formatBalance(0.004, '¥'), '<¥0.01')
    assert.equal(formatBalance(12.345, '¥'), '¥12.34')
    assert.equal(formatBalance(12345.6, '$'), '$12,345.60')
    assert.equal(compactBalance(1234.5, '¥'), '¥1.2k')
    assert.equal(compactBalance(12_000, '¥'), '¥12k')
    assert.equal(compactBalance(1_500_000, '¥'), '¥1.5m')

    assert.deepEqual(readRechargeBalance({
      status: 'ready',
      value: [{ currency: 'USD', balance: '3.00' }, { currency: 'CNY', balance: '12.34' }],
      bonusWallets: [{ currency: 'CNY', balance: '99.00' }],
    }), { kind: 'ready', text: '¥12.34', full: '¥12.34' })
  })

  it('sums wallets of the preferred currency and reports the missing cases', () => {
    assert.deepEqual(readRechargeBalance({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '1.00' }, { currency: 'CNY', balance: '2.50' }],
    }), { kind: 'ready', text: '¥3.50', full: '¥3.50' })
    assert.deepEqual(readRechargeBalance({ status: 'ready', value: [], bonusWallets: [{ currency: 'CNY', balance: '9' }] }), { kind: 'unavailable' })
    assert.deepEqual(readRechargeBalance(null), { kind: 'signed-out' })
    assert.deepEqual(readRechargeBalance({ status: 'failed' }), { kind: 'failed' })
  })
})

describe('balance monitor', () => {
  const client = { version: '0.0.0', locale: 'zh-CN', timezoneOffsetSeconds: 0 }

  it('coalesces reads and keeps the last number across a failed poll', async () => {
    let now = 1_000
    let calls = 0
    let fail = false
    const monitor = new BalanceMonitor({
      account: () => ({
        async getBalance() {
          calls += 1
          if (fail) throw new Error('offline')
          return { status: 'ready', value: [{ currency: 'CNY', balance: '8.50' }] }
        },
      }),
      client: () => client,
      now: () => now,
    })
    assert.deepEqual(await monitor.refresh(), { text: '¥8.50', full: '¥8.50', state: 'ready' })
    now += 1_000
    assert.equal((await monitor.refresh()).text, '¥8.50')
    assert.equal(calls, 1, 'the short window reuses the read')
    fail = true
    now += 16_000
    const failed = await monitor.refresh()
    assert.equal(failed.text, '¥8.50', 'a failed poll keeps the last amount')
    assert.equal(failed.state, 'error')
    assert.equal(calls, 2)
  })

  it('clears a signed-out account and tolerates a missing service', async () => {
    const signedOut = new BalanceMonitor({
      account: () => ({ getBalance: async () => null }),
      client: () => client,
    })
    assert.deepEqual(await signedOut.refresh(), { text: null, full: null, state: 'signed-out' })

    const missing = new BalanceMonitor({ account: () => undefined, client: () => client })
    assert.deepEqual(await missing.refresh(), { text: null, full: null, state: 'unavailable' })
  })
})
