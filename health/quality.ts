import { lookup as dnsLookup } from 'node:dns/promises'
import { connect as netConnect } from 'node:net'

import { askHost } from 'kehikot-module-protocol/serve'

import { ID } from '../manifest.ts'
import {
  badSinceAfter,
  hostsFrom,
  isAddress,
  judge,
  keptRounds,
  parseHosts,
  PROBE_EVERY_MS,
  PROBE_TIMEOUT_MS,
  qualityOf,
  targetsOf,
  type Probe,
  type Quality,
  type Round,
} from '../src/health/quality.ts'
import { WATCH_MS } from './sampler.ts'
import { SPEED, type SpeedTest } from './speed.ts'

/**
 * The connection's quality, probed by Monitor's server (`src/health/quality.ts` says how and how it is judged).
 *
 * The same rule as the Health sampler: nothing is sent until the page or the `health` tool asks
 * (`snapshot`); then a round every `PROBE_EVERY_MS` for `WATCH_MS` after the last ask, and nothing after
 * that. Which hosts Kehikot calls out to is read from its record of traffic every `HOSTS_EVERY_MS` while
 * probing. What is held is `QUALITY_HISTORY_MS` of rounds, in memory; nothing is written anywhere.
 */

export const HOSTS_EVERY_MS = 60_000

export interface QualityDeps {
  /** Look a name up; resolves to an address. */
  lookup: (host: string) => Promise<string>
  /** Open a TCP connection to an address and port, then close it; resolves once it opened. */
  connect: (address: string, port: number, timeoutMs: number) => Promise<void>
  /** A monotonic clock in ms, for timing a probe. */
  tick: () => number
  /** The wall clock. */
  now: () => number
  /** The hosts Kehikot calls out to, from its record of traffic; [] when it cannot say. */
  called: () => Promise<string[]>
  /** `MONITOR_PROBE_HOSTS`. */
  configured: string | undefined
  timeoutMs: number
  /** Between rounds while watched. */
  everyMs: number
}

export const QUALITY_DEPS: QualityDeps = {
  lookup: async (host) => (await dnsLookup(host)).address,
  connect: (address, port, timeoutMs) =>
    new Promise((resolve, reject) => {
      const socket = netConnect({ host: address, port, timeout: timeoutMs })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('timeout', () => {
        socket.destroy()
        reject(new Error('timeout'))
      })
      socket.once('error', (error) => {
        socket.destroy()
        reject(error)
      })
    }),
  tick: () => performance.now(),
  now: () => Date.now(),
  called: async () => {
    const read = await askHost('traffic.read', { since: 0, limit: 2000 }, { module: ID })
    return read.ok ? hostsFrom(read.data.calls) : []
  },
  configured: process.env.MONITOR_PROBE_HOSTS,
  timeoutMs: PROBE_TIMEOUT_MS,
  everyMs: PROBE_EVERY_MS,
}

/** `work`, or a rejection after `ms`. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** One probe: the name looked up (timed), then a TCP connection to port 443 (timed); lost after `timeoutMs` in all. */
export async function probe(host: string, deps: Pick<QualityDeps, 'lookup' | 'connect' | 'tick' | 'timeoutMs'>): Promise<Probe> {
  const start = deps.tick()
  let address = host
  let dns: number | null = null
  if (!isAddress(host)) {
    try {
      address = await within(deps.lookup(host), deps.timeoutMs)
      dns = deps.tick() - start
    } catch (error) {
      const late = error instanceof Error && error.message === 'timeout'
      return { host, ms: null, dns: null, why: late ? `the name did not resolve in ${deps.timeoutMs / 1000} s` : 'the name did not resolve' }
    }
  }
  const left = Math.max(1, deps.timeoutMs - (deps.tick() - start))
  const opened = deps.tick()
  try {
    await within(deps.connect(address, 443, left), left)
    return { host, ms: Math.max(0, deps.tick() - opened), dns: dns === null ? null : Math.max(0, dns), why: '' }
  } catch (error) {
    const late = error instanceof Error && error.message === 'timeout'
    return { host, ms: null, dns, why: late ? `no answer in ${deps.timeoutMs / 1000} s` : 'the connection was refused' }
  }
}

export class QualitySampler {
  private readonly deps: QualityDeps
  private readonly speed: SpeedTest
  private watchedUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private probing: Promise<void> | null = null
  private lastRound = 0
  private rounds: Round[] = []
  private called: string[] = []
  private calledAt = 0
  private targets: string[] = []
  private badSince: number | null = null

  constructor(deps: QualityDeps = QUALITY_DEPS, speed: SpeedTest = SPEED) {
    this.deps = deps
    this.speed = speed
  }

  /**
   * Somebody looked: keep probing for a while, start a round if the last is stale, and say what is held.
   * `wait`: wait for that round when none is held yet (the tool, which answers once); the page does not wait.
   */
  async snapshot(wait = false): Promise<Quality> {
    const now = this.deps.now()
    this.watchedUntil = now + WATCH_MS
    if (now - this.lastRound >= this.deps.everyMs - 300) void this.round()
    if (wait && !this.rounds.length && this.probing) await this.probing
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
      void this.round().finally(() => this.schedule())
    }
    this.timer = setTimeout(tick, this.deps.everyMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  round(): Promise<void> {
    if (!this.probing) this.probing = this.take().finally(() => (this.probing = null))
    return this.probing
  }

  private async take(): Promise<void> {
    const at = this.deps.now()
    this.lastRound = at
    if (!this.calledAt || at - this.calledAt >= HOSTS_EVERY_MS) {
      this.calledAt = at
      try {
        this.called = await this.deps.called()
      } catch {
        /* Kehikot would not say: keep the hosts it last said. */
      }
    }
    this.targets = targetsOf(parseHosts(this.deps.configured), this.called)
    const probes = await Promise.all(this.targets.map((host) => probe(host, this.deps)))
    this.rounds = keptRounds(this.rounds, { at, probes })
    this.badSince = badSinceAfter(this.badSince, judge(this.rounds).level, at)
  }

  private said(): Quality {
    return qualityOf(this.rounds, this.targets, this.badSince, this.speed.state())
  }
}

/** The one prober of this server. */
export const QUALITY = new QualitySampler()
