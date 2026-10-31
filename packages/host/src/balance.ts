/**
 * The signed-in DeepSeek account's recharge balance for the lasso satellite.
 *
 * The official account service owns the token and platform headers, so this module never
 * stores or sees an API key. Only the normal (recharge) wallets count; granted bonus
 * wallets are deliberately left out of the number on the ball.
 * @module dsh-orb/host/balance
 */

/** Re-read the account balance while the satellite shows it. */
export const BALANCE_REFRESH_MS = 5 * 60_000
/** A settings change and the periodic poll may ask in the same breath; share that read. */
const MIN_REFRESH_GAP_MS = 15_000

/** The client identity the account platform expects on a balance query. */
export interface BalanceAccountClient {
  readonly version: string
  readonly locale: string
  readonly timezoneOffsetSeconds: number
}

/** The slice of the official `deepseekAccount` service this module reads. */
export interface BalanceAccount {
  getBalance(client: BalanceAccountClient): Promise<unknown>
}

export type BalanceStatus = 'ready' | 'signed-out' | 'unavailable' | 'error'

/** What the ball and the settings card show. A failed refresh keeps the last text. */
export interface BalanceSnapshot {
  /** Compact text for the 56px satellite, or null when there is nothing to show. */
  readonly text: string | null
  /** Full grouped text for the settings card. */
  readonly full: string | null
  readonly state: BalanceStatus
}

export const EMPTY_BALANCE: BalanceSnapshot = { text: null, full: null, state: 'unavailable' }

interface Wallet {
  readonly currency: string
  readonly balance: string
}

type BalanceRead =
  | { readonly kind: 'ready'; readonly text: string; readonly full: string }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' }

/**
 * Read one platform balance outcome.
 * @param outcome - the account service's result: {@link null}, `{status:'ready', value}`, or `{status:'failed'}`.
 * @returns the recharge amount, or why there is none.
 */
export function readRechargeBalance(outcome: unknown): BalanceRead {
  if (outcome === null) return { kind: 'signed-out' }
  if (typeof outcome !== 'object') return { kind: 'failed' }
  const record = outcome as { status?: unknown; value?: unknown }
  if (record.status === 'failed') return { kind: 'failed' }
  if (record.status !== 'ready') return { kind: 'failed' }
  const wallets = readWallets(record.value)
  if (wallets.length === 0) return { kind: 'unavailable' }
  const currency = wallets.some(wallet => wallet.currency === 'CNY')
    ? 'CNY'
    : wallets.some(wallet => wallet.currency === 'USD') ? 'USD' : wallets[0]?.currency
  if (currency === undefined) return { kind: 'unavailable' }
  const selected = wallets.filter(wallet => wallet.currency === currency)
  let total = 0
  for (const wallet of selected) {
    const amount = Number(wallet.balance)
    if (Number.isFinite(amount)) total += amount
  }
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
  return { kind: 'ready', text: compactBalance(total, symbol), full: formatBalance(total, symbol) }
}

function readWallets(value: unknown): readonly Wallet[] {
  if (!Array.isArray(value)) return []
  const wallets: Wallet[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as { currency?: unknown; balance?: unknown }
    if (typeof record.currency !== 'string' || typeof record.balance !== 'string') continue
    if (!Number.isFinite(Number(record.balance))) continue
    wallets.push({ currency: record.currency, balance: record.balance })
  }
  return wallets
}

/** Platform Web's two-decimal, sub-cent display rules. */
export function formatBalance(amount: number, symbol: string): string {
  if (amount === 0) return `${symbol}0.00`
  if (amount < 0) {
    return `-${symbol}${Math.abs(amount) < 0.01 ? '0.01' : grouped(Math.abs(amount).toFixed(2))}`
  }
  if (amount < 0.01) return `<${symbol}0.01`
  return `${symbol}${grouped((Math.floor(amount * 100) / 100).toFixed(2))}`
}

/** Keep the satellite readable: grouped digits fall back to thousands/millions. */
export function compactBalance(amount: number, symbol: string): string {
  const absolute = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  if (absolute >= 1_000_000) return `${sign}${symbol}${trimZero((absolute / 1_000_000).toFixed(1))}m`
  if (absolute >= 10_000) return `${sign}${symbol}${Math.round(absolute / 1000)}k`
  if (absolute >= 1_000) return `${sign}${symbol}${trimZero((absolute / 1000).toFixed(1))}k`
  return formatBalance(amount, symbol)
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

function grouped(value: string): string {
  const [integer, fraction] = value.split('.')
  return `${Number(integer).toLocaleString('en-US')}.${fraction}`
}

/**
 * Cache one account balance and expose it as a widget-sized snapshot.
 * The caller owns the refresh schedule: enabling the toggle, a five-minute timer, and a
 * finished turn all call {@link refresh}.
 */
export class BalanceMonitor {
  private value: BalanceSnapshot = EMPTY_BALANCE
  private inflight: Promise<BalanceSnapshot> | undefined
  /** Negative infinity so the first refresh is never mistaken for a recent read. */
  private lastAt = Number.NEGATIVE_INFINITY
  private error: string | null = null

  constructor(
    private readonly deps: {
      readonly account: () => BalanceAccount | undefined
      readonly client: () => BalanceAccountClient
      readonly now?: () => number
      readonly log?: (message: string) => void
    },
  ) {}

  current(): BalanceSnapshot {
    return this.value
  }

  /** Diagnostic detail for the settings card; never rendered on the ball. */
  lastError(): string | null {
    return this.error
  }

  /**
   * Read the account once and fold the outcome into {@link current}.
   * @param force - skip the short coalescing window (a settings toggle, not a poll).
   * @returns the snapshot now current.
   */
  refresh(force = false): Promise<BalanceSnapshot> {
    if (this.inflight !== undefined) return this.inflight
    const now = this.deps.now ?? Date.now
    if (!force && now() - this.lastAt < MIN_REFRESH_GAP_MS) return Promise.resolve(this.value)
    this.lastAt = now()
    this.inflight = this.read().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Stop showing a value that no longer belongs to the account. */
  clear(): void {
    this.value = EMPTY_BALANCE
    this.lastAt = Number.NEGATIVE_INFINITY
    this.error = null
  }

  private async read(): Promise<BalanceSnapshot> {
    const account = this.deps.account()
    if (account === undefined) {
      this.value = EMPTY_BALANCE
      this.error = 'account service missing'
      return this.value
    }
    try {
      const read = readRechargeBalance(await account.getBalance(this.deps.client()))
      if (read.kind === 'ready') {
        this.value = { text: read.text, full: read.full, state: 'ready' }
        this.error = null
      } else if (read.kind === 'signed-out' || read.kind === 'unavailable') {
        this.value = { text: null, full: null, state: read.kind === 'signed-out' ? 'signed-out' : 'unavailable' }
        this.error = read.kind === 'signed-out' ? 'signed out' : 'no recharge wallet'
      } else {
        // Keep a previously read amount rather than blinking to empty on one failed poll.
        this.value = { ...this.value, state: 'error' }
        this.error = 'balance query failed'
      }
    } catch (error) {
      if (this.value.text === null) {
        this.value = { text: null, full: null, state: 'error' }
      } else {
        this.value = { ...this.value, state: 'error' }
      }
      this.error = error instanceof Error ? error.message : String(error)
      this.deps.log?.(`balance read failed: ${this.error}`)
    }
    return this.value
  }
}
