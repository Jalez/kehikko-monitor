import { readFile } from 'node:fs/promises'

import {
  emptyNet,
  interfacesOf,
  kept,
  ownerOf,
  parseComm,
  parseNetstat,
  parseNettop,
  parseProcNetDev,
  rateOf,
  topOf,
  type Counter,
  type NetPoint,
  type NetSnapshot,
  type TopProc,
} from '../src/health/network.ts'
import { DEPS as HEALTH_DEPS, SAMPLER, WATCH_MS } from './sampler.ts'

/**
 * The machine's network throughput, read by Monitor's server (`src/health/network.ts` says how).
 *
 * The same rule as the Health sampler: nothing runs until the page or the `health` tool asks
 * (`snapshot`); then the counters are read every `NET_EVERY_MS` for `WATCH_MS` after the last ask,
 * and nothing after that. The busiest processes are read every `TOP_MS` on macOS. What is held is
 * `HISTORY_MS` of rates, in memory; nothing is written anywhere.
 */

export const NET_EVERY_MS = 2_000
export const TOP_MS = 10_000

export interface NetDeps {
  run: (file: string, args: string[], timeoutMs: number) => Promise<string>
  read: (file: string) => Promise<string>
  now: () => number
  platform: string
  /** Which pids belong to which Kehikot module (pid → module id), as the Health sampler last saw them. */
  owners: () => ReadonlyMap<number, string>
}

export const NET_DEPS: NetDeps = {
  run: HEALTH_DEPS.run,
  read: (file) => readFile(file, 'utf8'),
  now: () => Date.now(),
  platform: process.platform,
  owners: () => SAMPLER.owners(),
}

type Nettop = ReturnType<typeof parseNettop>

export class NetworkSampler {
  private readonly deps: NetDeps
  private watchedUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private sampling: Promise<void> | null = null
  private lastSample = 0
  private before: { at: number; counters: Counter[] } | null = null
  private rate: { down: number; up: number } | null = null
  private points: NetPoint[] = []
  private interfaces: string[] = []
  private why = ''
  private topBefore: { at: number; procs: Nettop } | null = null
  private top: TopProc[] | null = null
  private topAt = 0

  constructor(deps: NetDeps = NET_DEPS) {
    this.deps = deps
  }

  /** Somebody looked: keep reading for a while, read now if the last is stale, and say what is held. */
  async snapshot(): Promise<NetSnapshot> {
    const now = this.deps.now()
    this.watchedUntil = now + WATCH_MS
    if (now - this.lastSample >= NET_EVERY_MS - 300) await this.sample()
    this.schedule()
    return this.said()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watchedUntil = 0
  }

  private schedule(): void {
    if (this.timer) return
    const tick = () => {
      this.timer = null
      if (this.deps.now() >= this.watchedUntil) return
      void this.sample().finally(() => this.schedule())
    }
    this.timer = setTimeout(tick, NET_EVERY_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  sample(): Promise<void> {
    if (!this.sampling) this.sampling = this.take().finally(() => (this.sampling = null))
    return this.sampling
  }

  private async counters(): Promise<Counter[]> {
    if (this.deps.platform === 'linux') return parseProcNetDev(await this.deps.read('/proc/net/dev'))
    return parseNetstat(await this.deps.run('netstat', ['-ibn'], 3_000))
  }

  private async take(): Promise<void> {
    const now = this.deps.now()
    this.lastSample = now
    let counters: Counter[]
    try {
      counters = await this.counters()
      this.why = ''
    } catch (error) {
      this.why = `Monitor could not read this computer's network counters: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    if (this.before) {
      this.rate = rateOf(this.before.counters, counters, (now - this.before.at) / 1000)
      this.points = kept(this.points, { at: now, ...this.rate })
    }
    this.before = { at: now, counters }
    this.interfaces = interfacesOf(counters)
    if (this.deps.platform === 'darwin' && (!this.topAt || now - this.topAt >= TOP_MS)) await this.readTop(now)
  }

  /** The busiest processes on external interfaces: nettop's totals, and the executables to say whose they are. */
  private async readTop(now: number): Promise<void> {
    this.topAt = now
    let procs: Nettop
    try {
      procs = parseNettop(await this.deps.run('nettop', ['-P', '-L', '1', '-t', 'external', '-x', '-J', 'bytes_in,bytes_out'], 3_000))
    } catch {
      this.top = null
      this.topBefore = null
      return
    }
    const before = this.topBefore
    this.topBefore = { at: now, procs }
    if (!before) return
    const found = topOf(before.procs, procs, (now - before.at) / 1000)
    let tree = new Map<number, { ppid: number; comm: string }>()
    if (found.length) {
      try {
        tree = parseComm(await this.deps.run('ps', ['-A', '-o', 'pid=,ppid=,comm='], 3_000))
      } catch {
        /* Said by name alone. */
      }
    }
    const owners = this.deps.owners()
    this.top = found.map((one) => ({ ...one, owner: ownerOf(one.pid, tree, owners) }))
  }

  private said(): NetSnapshot {
    return {
      ...emptyNet(),
      at: this.lastSample,
      every: NET_EVERY_MS / 1000,
      down: this.rate?.down ?? null,
      up: this.rate?.up ?? null,
      points: this.points,
      interfaces: this.interfaces,
      top: this.top,
      why: this.why,
    }
  }
}

/** The one network sampler of this server. */
export const NETWORK = new NetworkSampler()
