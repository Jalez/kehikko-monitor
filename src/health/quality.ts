import type { TrafficCall } from 'kehikot-module-protocol'

/**
 * The quality of this computer's internet connection: not how much it carries (that is the throughput,
 * `network.ts`), but whether it is good — how long a round trip takes, how many tries get no answer, how
 * steady the round trips are, and how long a name takes to look up. Pure and shared by the server's
 * prober (`health/quality.ts`), the page, the footer, the Inbox item and the `health` tool.
 *
 * How it is measured, without root and with nothing native:
 *
 * - Every `PROBE_EVERY_MS`, while somebody looks (the same rule as Health), one probe to each target:
 *   the hosts Kehikot really calls out to (from Kehikot's own record of traffic, `hostsFrom`), always
 *   github.com, any host named in `MONITOR_PROBE_HOSTS`, and one public anycast address (`PUBLIC_HOST`).
 * - A probe looks the name up (timed: the name lookup), then opens a TCP connection to port 443 and closes
 *   it (timed: the round trip — a TCP handshake is one). No ICMP ping: it needs privileges and is often
 *   blocked, while port 443 is what every call Kehikot makes goes through.
 * - A probe that gets no answer within `PROBE_TIMEOUT_MS`, or whose name does not resolve, is lost.
 * - Jitter is how much one host's round trip moves from one probe to the next (the mean of the
 *   differences between consecutive answered probes).
 * - The verdict (`judge`) reads the last `VERDICT_ROUNDS` rounds (a minute); `QUALITY_HISTORY_MS` (ten
 *   minutes) of rounds is kept, in memory.
 */

/** How often a round of probes is sent while somebody looks. */
export const PROBE_EVERY_MS = 10_000
/** A probe (the name lookup, then the connection) that takes longer than this is lost. */
export const PROBE_TIMEOUT_MS = 2_000
/** How far back the rounds are kept. */
export const QUALITY_HISTORY_MS = 10 * 60_000
/** How many of the newest rounds the verdict reads: a minute's. */
export const VERDICT_ROUNDS = 6
/** The public anycast address every round also probes: answered nearby wherever this computer is. */
export const PUBLIC_HOST = '1.1.1.1'
/** The tracker host Kehikot always depends on. */
export const ALWAYS = ['github.com']
/** At most this many named hosts are probed, besides the public address. */
export const MOST_HOSTS = 4
/** How long the verdict must stay Poor or Offline before it is an Inbox item. */
export const BAD_FOR_MS = 60_000

/**
 * Where Good ends and Fair and Poor begin. A connection is judged by its worst figure:
 *
 * - Round trip (each host's median over the last minute): Good under `goodMs`, Fair under `fairMs`,
 *   Poor from there. 80 ms is a good connection across a continent; 200 ms makes every call feel slow.
 * - Probes lost (over the last minute, every host): Good at none, Fair under `fairLoss`, Poor from there.
 *   A few percent lost already stalls a push or a download while TCP waits to send again.
 * - Jitter (each host's): Good under `goodJitterMs`, Fair under `fairJitterMs`, Poor from there.
 * - Name lookup (each host's median): Good under `goodDnsMs`, Fair under `fairDnsMs`, Poor from there.
 * - Offline: the newest round got no answer from any host, the public address included.
 */
export const THRESHOLDS = {
  goodMs: 80,
  fairMs: 200,
  fairLoss: 0.05,
  goodJitterMs: 30,
  fairJitterMs: 100,
  goodDnsMs: 150,
  fairDnsMs: 500,
} as const

/* ------------------------------------------------------------------ *
 * What a probe is.
 * ------------------------------------------------------------------ */

/** One probe to one host: the round trip in ms (null: lost), the name lookup in ms (null for an address, or when it failed). */
export interface Probe {
  host: string
  ms: number | null
  dns: number | null
  /** Why it was lost: a sentence. '' when it answered. */
  why: string
}

export interface Round {
  at: number
  probes: Probe[]
}

export type QualityLevel = 'measuring' | 'good' | 'fair' | 'poor' | 'offline'

export const LEVEL_WORD: Record<QualityLevel, string> = { measuring: 'Measuring', good: 'Good', fair: 'Fair', poor: 'Poor', offline: 'Offline' }

const RANK: Record<QualityLevel, number> = { measuring: 0, good: 1, fair: 2, poor: 3, offline: 4 }

/** Whether a name is an address already (no lookup). */
export const isAddress = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')

/** A host name a probe may be sent to: letters, digits, dots and dashes, with a dot, or an IPv4 address. */
export const isProbeHost = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) && host.length <= 253)

/** This computer, the local network, or not a name at all: never probed. */
function isLocal(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return true
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

/** A `host[:port]` or a URL as a bare, lower-case host name; '' when it is none. */
export function hostOf(text: string): string {
  let host = text.trim().toLowerCase()
  if (!host) return ''
  try {
    if (host.includes('://')) host = new URL(host).hostname
  } catch {
    return ''
  }
  host = host.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/\.$/, '')
  return isProbeHost(host) ? host : ''
}

/** `MONITOR_PROBE_HOSTS`: host names or URLs, separated by commas or spaces. What does not read is skipped. */
export function parseHosts(text: string | undefined): string[] {
  if (!text) return []
  return [...new Set(text.split(/[\s,]+/).map(hostOf).filter((one) => one && !isLocal(one)))]
}

/**
 * The hosts Kehikot really calls out to, from its record of traffic: the calls it MADE (`side: 'out'`),
 * not this computer or the local network, the most called first.
 */
export function hostsFrom(calls: readonly Pick<TrafficCall, 'host' | 'side'>[], most = MOST_HOSTS): string[] {
  const counts = new Map<string, number>()
  for (const call of calls) {
    if (call.side !== 'out') continue
    const host = hostOf(call.host)
    if (!host || isLocal(host)) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, most).map(([host]) => host)
}

/** What a round probes: the configured hosts first, then what Kehikot calls, then github.com; at most `MOST_HOSTS`, then the public address. */
export function targetsOf(configured: readonly string[], called: readonly string[]): string[] {
  const named = [...new Set([...configured, ...called, ...ALWAYS])].filter((one) => one !== PUBLIC_HOST).slice(0, MOST_HOSTS)
  return [...named, PUBLIC_HOST]
}

/** The rounds with `round` added and anything older than `windowMs` before it dropped. */
export function keptRounds(rounds: readonly Round[], round: Round, windowMs = QUALITY_HISTORY_MS): Round[] {
  return [...rounds, round].filter((one) => one.at > round.at - windowMs)
}

/* ------------------------------------------------------------------ *
 * Figures.
 * ------------------------------------------------------------------ */

export function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** The mean of the differences between consecutive answered round trips; null under two. */
export function jitterOf(values: readonly number[]): number | null {
  if (values.length < 2) return null
  let sum = 0
  for (let i = 1; i < values.length; i++) sum += Math.abs((values[i] as number) - (values[i - 1] as number))
  return sum / (values.length - 1)
}

/** One host over some rounds. */
export interface HostStat {
  host: string
  /** The public anycast address, not a host Kehikot calls. */
  public: boolean
  sent: number
  lost: number
  /** The median round trip, ms; null when none answered. */
  ms: number | null
  jitter: number | null
  /** The median name lookup, ms; null for an address or when none resolved. */
  dns: number | null
  /** Why the newest lost probe was lost; ''. */
  why: string
}

export function hostStats(rounds: readonly Round[]): HostStat[] {
  const order: string[] = []
  const by = new Map<string, Probe[]>()
  for (const round of rounds)
    for (const probe of round.probes) {
      if (!by.has(probe.host)) {
        by.set(probe.host, [])
        order.push(probe.host)
      }
      by.get(probe.host)?.push(probe)
    }
  return order.map((host) => {
    const probes = by.get(host) ?? []
    const answered = probes.flatMap((one) => (one.ms === null ? [] : [one.ms]))
    const lookups = probes.flatMap((one) => (one.dns === null ? [] : [one.dns]))
    return {
      host,
      public: host === PUBLIC_HOST,
      sent: probes.length,
      lost: probes.length - answered.length,
      ms: median(answered),
      jitter: jitterOf(answered),
      dns: median(lookups),
      why: [...probes].reverse().find((one) => one.ms === null)?.why ?? '',
    }
  })
}

/* ------------------------------------------------------------------ *
 * The verdict.
 * ------------------------------------------------------------------ */

export interface Verdict {
  level: QualityLevel
  /** Good, Fair, Poor, Offline, Measuring. */
  word: string
  /** The median round trip over every answered probe of the last minute, ms. */
  ms: number | null
  /** Probes lost over the last minute, of `sent`. */
  lost: number
  sent: number
  /** The worst host's jitter, ms. */
  jitter: number | null
  /** The slowest host's median name lookup, ms. */
  dns: number | null
  /** Why, in a short sentence: "high latency to gitlab.example.com: 420 ms". */
  reason: string
}

const ms = (value: number) => `${Math.round(value)} ms`

/** "0%", "3%", "33%": loss as a whole percent, a loss under one percent said as "<1%". */
export function lossSaid(lost: number, sent: number): string {
  if (!sent || !lost) return '0%'
  const share = (lost / sent) * 100
  return share < 1 ? '<1%' : `${Math.round(share)}%`
}

interface Problem {
  level: QualityLevel
  /** How far past its threshold, to say the worst first. */
  by: number
  reason: string
}

function graded(value: number | null, good: number, fair: number): QualityLevel {
  if (value === null) return 'good'
  return value < good ? 'good' : value < fair ? 'fair' : 'poor'
}

/** Judge the newest `VERDICT_ROUNDS` rounds (see `THRESHOLDS`). */
export function judge(rounds: readonly Round[]): Verdict {
  const recent = rounds.slice(-VERDICT_ROUNDS)
  const empty = { ms: null, lost: 0, sent: 0, jitter: null, dns: null }
  const newest = recent.at(-1)
  if (!newest || !newest.probes.length) return { level: 'measuring', word: LEVEL_WORD.measuring, ...empty, reason: 'The first probes are on their way.' }
  const stats = hostStats(recent)
  const answered = recent.flatMap((round) => round.probes.flatMap((one) => (one.ms === null ? [] : [one.ms])))
  const sent = stats.reduce((sum, one) => sum + one.sent, 0)
  const lost = stats.reduce((sum, one) => sum + one.lost, 0)
  const jitters = stats.flatMap((one) => (one.jitter === null ? [] : [one.jitter]))
  const lookups = stats.flatMap((one) => (one.dns === null ? [] : [one.dns]))
  const figures = { ms: median(answered), lost, sent, jitter: jitters.length ? Math.max(...jitters) : null, dns: lookups.length ? Math.max(...lookups) : null }

  if (newest.probes.every((one) => one.ms === null)) {
    return { level: 'offline', word: LEVEL_WORD.offline, ...figures, reason: `no answer from ${newest.probes.length === 1 ? (newest.probes[0] as Probe).host : `any of ${newest.probes.length} hosts`}` }
  }

  const problems: Problem[] = []
  for (const one of stats) {
    const level = graded(one.ms, THRESHOLDS.goodMs, THRESHOLDS.fairMs)
    if (level !== 'good' && one.ms !== null) problems.push({ level, by: one.ms / THRESHOLDS.goodMs, reason: `${level === 'poor' ? 'high latency' : 'latency'} to ${one.host}: ${ms(one.ms)}` })
    const shaky = graded(one.jitter, THRESHOLDS.goodJitterMs, THRESHOLDS.fairJitterMs)
    if (shaky !== 'good' && one.jitter !== null) problems.push({ level: shaky, by: one.jitter / THRESHOLDS.goodJitterMs, reason: `unsteady latency to ${one.host}: jitter ${ms(one.jitter)}` })
    const slow = graded(one.dns, THRESHOLDS.goodDnsMs, THRESHOLDS.fairDnsMs)
    if (slow !== 'good' && one.dns !== null) problems.push({ level: slow, by: one.dns / THRESHOLDS.goodDnsMs, reason: `slow name lookup for ${one.host}: ${ms(one.dns)}` })
  }
  if (lost) {
    const share = lost / sent
    const losers = stats.filter((one) => one.lost)
    const whose = losers.length === 1 ? ` (all to ${(losers[0] as HostStat).host})` : ''
    problems.push({ level: share < THRESHOLDS.fairLoss ? 'fair' : 'poor', by: 1 + share * 100, reason: `${lost} of ${sent} probes lost${whose}` })
  }
  if (!problems.length) {
    return { level: 'good', word: LEVEL_WORD.good, ...figures, reason: `${stats.length === 1 ? 'the host answers' : `all ${stats.length} hosts answer`} quickly, nothing lost` }
  }
  problems.sort((a, b) => RANK[b.level] - RANK[a.level] || b.by - a.by)
  const worst = problems[0] as Problem
  return { level: worst.level, word: LEVEL_WORD[worst.level], ...figures, reason: worst.reason }
}

/** When the verdict turned Poor or Offline, kept while it stays so; null when it is not. */
export function badSinceAfter(was: number | null, level: QualityLevel, at: number): number | null {
  if (level === 'poor' || level === 'offline') return was ?? at
  return null
}

/** One point of the latency line per round: the median round trip; null when nothing answered. */
export interface LatencyPoint {
  at: number
  ms: number | null
}

export const latencyPoints = (rounds: readonly Round[]): LatencyPoint[] =>
  rounds.map((round) => ({ at: round.at, ms: median(round.probes.flatMap((one) => (one.ms === null ? [] : [one.ms]))) }))

/**
 * The throughput's points with the latency of the round at or just before each (`ms`), for one chart of
 * both: null where that round got no answer, absent where no round is near.
 */
export function withLatency<T extends { at: number }>(points: readonly T[], latency: readonly LatencyPoint[], near = PROBE_EVERY_MS * 1.6): (T & { ms?: number | null })[] {
  let i = 0
  return points.map((point) => {
    while (i + 1 < latency.length && (latency[i + 1] as LatencyPoint).at <= point.at) i++
    const round = latency[i]
    if (!round || round.at > point.at || point.at - round.at > near) return { ...point }
    return { ...point, ms: round.ms }
  })
}

/* ------------------------------------------------------------------ *
 * The speed test.
 * ------------------------------------------------------------------ */

/** What a speed test asks for: the downloads and uploads, in bytes, one after another. The first of each warms the connection and is not counted. */
export const SPEED_PLAN = { down: [1e6, 4e6, 10e6, 10e6], up: [1e6, 4e6, 5e6] } as const
/** A phase that runs longer than this is cut short, and measured on what it moved. */
export const SPEED_PHASE_MS = 8_000
export const SPEED_SAID = `Downloads about ${Math.round(SPEED_PLAN.down.reduce((a, b) => a + b, 0) / 1e6)} MB and uploads about ${Math.round(SPEED_PLAN.up.reduce((a, b) => a + b, 0) / 1e6)} MB from Cloudflare.`

/** One transfer of a speed test: the bytes moved and the ms they took. */
export interface Transfer {
  bytes: number
  ms: number
}

/**
 * Bytes per second over the counted transfers: every transfer's bytes over every transfer's time,
 * the first (warm-up) left out when there is more than one. Null when nothing was moved.
 */
export function speedOf(transfers: readonly Transfer[]): number | null {
  const counted = transfers.length > 1 ? transfers.slice(1) : transfers
  const bytes = counted.reduce((sum, one) => sum + one.bytes, 0)
  const ms = counted.reduce((sum, one) => sum + one.ms, 0)
  return bytes > 0 && ms > 0 ? bytes / (ms / 1000) : null
}

export interface SpeedResult {
  /** When it finished. */
  at: number
  /** Bytes per second; null when that half moved nothing. */
  down: number | null
  up: number | null
  /** Bytes moved. */
  downBytes: number
  upBytes: number
}

export interface SpeedState {
  state: 'idle' | 'testing' | 'done' | 'failed' | 'cancelled'
  phase: 'download' | 'upload' | null
  /** The last finished test, kept over a later one that failed or was cancelled. */
  last: SpeedResult | null
  /** Why the newest test failed; ''. */
  why: string
}

export const idleSpeed = (): SpeedState => ({ state: 'idle', phase: null, last: null, why: '' })

/** "940 Mbit/s", "85 Mbit/s", "4.2 Mbit/s", "800 kbit/s": a speed test's figure, in bits as speed tests say them. */
export function bitsSaid(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return '—'
  const bits = bytesPerSecond * 8
  if (bits < 1e6) return `${Math.round(bits / 1e3)} kbit/s`
  if (bits < 1e9) return `${bits < 1e7 ? Math.round(bits / 1e5) / 10 : Math.round(bits / 1e6)} Mbit/s`
  return `${Math.round(bits / 1e8) / 10} Gbit/s`
}

/** "↓ 85 Mbit/s · ↑ 20 Mbit/s". */
export const speedSaid = (result: SpeedResult): string => `↓ ${bitsSaid(result.down)} · ↑ ${bitsSaid(result.up)}`

/* ------------------------------------------------------------------ *
 * What the server sends.
 * ------------------------------------------------------------------ */

export interface Quality {
  /** When the newest round was sent; 0 before the first. */
  at: number
  /** Seconds between rounds. */
  every: number
  /** What each round probes. */
  targets: string[]
  verdict: Verdict
  /** Each host over the last minute, then over the whole history. */
  hosts: HostStat[]
  history: HostStat[]
  /** The latency line, one point a round, oldest first, over `QUALITY_HISTORY_MS`. */
  points: LatencyPoint[]
  /** When the verdict turned Poor or Offline, while it stays so. */
  badSince: number | null
  speed: SpeedState
}

export const emptyQuality = (): Quality => ({
  at: 0,
  every: PROBE_EVERY_MS / 1000,
  targets: [],
  verdict: judge([]),
  hosts: [],
  history: [],
  points: [],
  badSince: null,
  speed: idleSpeed(),
})

/** Everything the page and the tool read, from the rounds held. */
export function qualityOf(rounds: readonly Round[], targets: readonly string[], badSince: number | null, speed: SpeedState): Quality {
  return {
    at: rounds.at(-1)?.at ?? 0,
    every: PROBE_EVERY_MS / 1000,
    targets: [...targets],
    verdict: judge(rounds),
    hosts: hostStats(rounds.slice(-VERDICT_ROUNDS)),
    history: hostStats(rounds),
    points: latencyPoints(rounds),
    badSince,
    speed,
  }
}

/* ------------------------------------------------------------------ *
 * Sentences.
 * ------------------------------------------------------------------ */

/** "Good · 24 ms · 0% loss"; `short`: "Good · 24 ms". Offline and measuring are the word alone. */
export function verdictSaid(verdict: Verdict, short = false): string {
  if (verdict.level === 'measuring' || verdict.level === 'offline' || verdict.ms === null) return verdict.word
  return short ? `${verdict.word} · ${ms(verdict.ms)}` : `${verdict.word} · ${ms(verdict.ms)} · ${lossSaid(verdict.lost, verdict.sent)} loss`
}

/** The footer's words: "Connection good · 24 ms", "Offline". */
export function connectionSaid(verdict: Verdict): string {
  if (verdict.level === 'offline') return 'Offline'
  if (verdict.level === 'measuring') return 'Connection: measuring'
  return `Connection ${verdict.word.toLowerCase()}${verdict.ms === null ? '' : ` · ${ms(verdict.ms)}`}`
}

/** A host as a line: "github.com: 24 ms · 0% loss · jitter 2 ms · lookup 12 ms". */
export function hostSaid(one: HostStat): string {
  const parts = [one.ms === null ? 'no answer' : ms(one.ms), `${lossSaid(one.lost, one.sent)} loss`]
  if (one.jitter !== null) parts.push(`jitter ${ms(one.jitter)}`)
  if (one.dns !== null) parts.push(`lookup ${ms(one.dns)}`)
  return `${one.host}${one.public ? ' (public)' : ''}: ${parts.join(' · ')}`
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`)

/** The speed test, as a sentence for the tool and the tile. */
export function speedLine(speed: SpeedState, now: number): string {
  const last = speed.last ? `The last speed test, ${ago(now - speed.last.at)}: download ${bitsSaid(speed.last.down)}, upload ${bitsSaid(speed.last.up)}.` : 'No speed test has been run since Monitor started; the person can run one from the Network tile (Test speed).'
  if (speed.state === 'testing') return `A speed test is running (${speed.phase ?? 'starting'}). ${speed.last ? last : ''}`.trim()
  if (speed.state === 'failed') return `The newest speed test failed: ${speed.why} ${speed.last ? last : ''}`.trim()
  return last
}

/**
 * The `health` tool's lines about the connection: the verdict and why, the figures of the last minute,
 * each host over the last minute and the last ten, the last speed test, and what to expect when it is poor.
 */
export function qualitySaid(quality: Quality, now: number): string[] {
  const { verdict } = quality
  if (!quality.at) return ['Connection quality: Monitor has not probed the connection yet. Ask again in a few seconds.']
  const lines = [`Connection quality: ${verdict.word} — ${verdict.reason}.`]
  if (verdict.level !== 'offline' && verdict.ms !== null)
    lines.push(`Over the last minute: median round trip ${ms(verdict.ms)}, ${verdict.lost} of ${verdict.sent} probes lost${verdict.jitter === null ? '' : `, jitter up to ${ms(verdict.jitter)}`}${verdict.dns === null ? '' : `, name lookups up to ${ms(verdict.dns)}`}. A probe is a TCP connection to port 443, every ${quality.every} s; lost after ${PROBE_TIMEOUT_MS / 1000} s.`)
  if (verdict.level === 'poor') lines.push('Expect long pushes, pulls and downloads to be slow or to fail; retry rather than give up, and prefer small steps.')
  if (verdict.level === 'offline') lines.push('This computer reaches none of them now: anything that needs the internet (a push, a pull, an install, a tracker) will fail until it is back.')
  lines.push('', 'Each host, the last minute:', ...quality.hosts.map((one) => `- ${hostSaid(one)}`))
  const span = quality.points.length > 1 ? Math.max(1, Math.round(((quality.points.at(-1) as LatencyPoint).at - (quality.points[0] as LatencyPoint).at) / 60_000)) : 0
  if (span > 1) lines.push('', `Each host, the last ${span} min:`, ...quality.history.map((one) => `- ${hostSaid(one)}`))
  lines.push('', speedLine(quality.speed, now))
  return lines
}

/** The latency's part of the chart's sentence. */
export function latencyChartSaid(quality: Quality): string {
  if (!quality.at) return ''
  return ` The connection is ${verdictSaid(quality.verdict).toLowerCase()}: ${quality.verdict.reason}.`
}
