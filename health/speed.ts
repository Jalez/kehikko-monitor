import { idleSpeed, SPEED_PHASE_MS, SPEED_PLAN, speedOf, type SpeedState, type Transfer } from '../src/health/quality.ts'

/**
 * The speed test: on demand only, never on its own, since it spends data. Downloads `SPEED_PLAN.down`
 * from `${base}/__down?bytes=N` and uploads `SPEED_PLAN.up` to `${base}/__up`, one after another; the
 * figure is `speedOf` the transfers. A phase longer than `SPEED_PHASE_MS` is cut short: a download counts
 * what arrived, an upload cut short is not counted. One test at a time; `cancel` stops it where it is.
 * The result is held in memory until a later test finishes.
 */

export const SPEED_BASE = 'https://speed.cloudflare.com'

export interface SpeedDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  base: string
  tick: () => number
  now: () => number
  plan: { down: readonly number[]; up: readonly number[] }
  phaseMs: number
}

export const SPEED_DEPS: SpeedDeps = {
  fetch: (input, init) => fetch(input, init),
  base: SPEED_BASE,
  tick: () => performance.now(),
  now: () => Date.now(),
  plan: SPEED_PLAN,
  phaseMs: SPEED_PHASE_MS,
}

class Cut extends Error {}

export class SpeedTest {
  private readonly deps: SpeedDeps
  private current: SpeedState = idleSpeed()
  private control: AbortController | null = null
  private running: Promise<void> | null = null

  constructor(deps: SpeedDeps = SPEED_DEPS) {
    this.deps = deps
  }

  state(): SpeedState {
    return { ...this.current }
  }

  /** Start a test, unless one is running; resolves when it is over (the door does not wait). */
  start(): Promise<void> {
    if (this.running) return this.running
    const control = new AbortController()
    this.control = control
    this.current = { ...this.current, state: 'testing', phase: 'download', why: '' }
    this.running = this.run(control.signal).finally(() => {
      this.running = null
      this.control = null
    })
    return this.running
  }

  /** Stop the running test where it is; what it measured is dropped. */
  cancel(): void {
    if (!this.control) return
    this.control.abort()
    this.current = { ...this.current, state: 'cancelled', phase: null }
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      const down = await this.phase(signal, this.deps.plan.down, (size, inner) => this.download(size, inner))
      if (signal.aborted) return
      this.current = { ...this.current, phase: 'upload' }
      const up = await this.phase(signal, this.deps.plan.up, (size, inner) => this.upload(size, inner))
      if (signal.aborted) return
      const result = {
        at: this.deps.now(),
        down: speedOf(down),
        up: speedOf(up),
        downBytes: down.reduce((sum, one) => sum + one.bytes, 0),
        upBytes: up.reduce((sum, one) => sum + one.bytes, 0),
      }
      if (result.down === null && result.up === null) throw new Error('nothing was moved.')
      this.current = { state: 'done', phase: null, last: result, why: '' }
    } catch (error) {
      if (signal.aborted) return
      this.current = { ...this.current, state: 'failed', phase: null, why: error instanceof Error ? error.message : String(error) }
    }
  }

  /** One phase: the transfers one after another until the plan is done or the phase's time is up. */
  private async phase(signal: AbortSignal, sizes: readonly number[], one: (size: number, signal: AbortSignal) => Promise<Transfer | null>): Promise<Transfer[]> {
    const done: Transfer[] = []
    const inner = new AbortController()
    const stop = () => inner.abort()
    signal.addEventListener('abort', stop)
    const timer = setTimeout(() => inner.abort(new Cut()), this.deps.phaseMs)
    try {
      for (const size of sizes) {
        if (inner.signal.aborted) break
        const moved = await one(size, inner.signal)
        if (moved) done.push(moved)
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
    return done
  }

  /** One download, timed from the first byte's arrival to the last; cut short, what arrived is counted. */
  private async download(size: number, signal: AbortSignal): Promise<Transfer | null> {
    let bytes = 0
    let from = 0
    try {
      const reply = await this.deps.fetch(`${this.deps.base}/__down?bytes=${size}`, { signal, cache: 'no-store' })
      if (!reply.ok || !reply.body) throw new Error(`the test server answered ${reply.status}.`)
      from = this.deps.tick()
      const reader = reply.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
      }
    } catch (error) {
      if (!signal.aborted) throw error
      if (!from || !bytes) return null
    }
    return { bytes, ms: Math.max(1, this.deps.tick() - from) }
  }

  /** One upload, timed from sending to the answer; cut short, it is not counted. */
  private async upload(size: number, signal: AbortSignal): Promise<Transfer | null> {
    const from = this.deps.tick()
    try {
      const reply = await this.deps.fetch(`${this.deps.base}/__up`, { method: 'POST', body: new Uint8Array(size), signal, headers: { 'content-type': 'application/octet-stream' } })
      await reply.arrayBuffer().catch(() => undefined)
      if (!reply.ok) throw new Error(`the test server answered ${reply.status}.`)
    } catch (error) {
      if (!signal.aborted) throw error
      return null
    }
    return { bytes: size, ms: Math.max(1, this.deps.tick() - from) }
  }
}

/** The one speed test of this server. */
export const SPEED = new SpeedTest()
