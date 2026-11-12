import { AGENT } from './heavy.ts'
import { nameOf } from './model.ts'

/**
 * The machine's network throughput: how fast this computer downloads and uploads right now, and over
 * the last few minutes. Pure and shared by the server's sampler (`health/network.ts`), the page and
 * the `health` tool's `network` view. This is NOT Monitor's traffic (the calls Kehikot and its modules
 * make): it is every byte the computer's network interfaces carry.
 *
 * How it is read, without root and with nothing native:
 *
 * - macOS: `netstat -ibn`, one line per interface (`<Link#n>`), its received and sent byte counters.
 * - Linux: `/proc/net/dev`, the same two counters per interface.
 * - Loopback and virtual interfaces (tunnels, bridges, VPNs, containers) are left out: a VPN's bytes
 *   also pass through the real interface, and counting both would say them twice.
 * - A rate is the counters' growth between two readings over the seconds between them. A counter that
 *   went down wrapped (a 32-bit counter) or was reset (the interface came back); an interface that
 *   appears is counted from its second reading.
 * - The busiest processes (macOS only), from `nettop -P -L 1 -t external`: each process's bytes in and
 *   out on external interfaces since it started, read every `TOP_MS`; the rate is again the growth.
 *   A process is said by its executable's name, or as the Kehikot module or agent session it belongs to.
 */

/* ------------------------------------------------------------------ *
 * Counters.
 * ------------------------------------------------------------------ */

/** One interface's byte counters: received (`rx`) and sent (`tx`). */
export interface Counter {
  name: string
  rx: number
  tx: number
}

/** Interfaces that are not a way out of this computer, or whose bytes another interface also carries. */
export const VIRTUAL = /^(lo|gif|stf|anpi|bridge|ap\d|awdl|llw|utun|ipsec|ppp|vmenet|vnic|veth|docker|br-|virbr|tun|tap|pktap|XHC|feth|zt|tailscale|wg)/

export const isPhysical = (name: string): boolean => !VIRTUAL.test(name)

/** `netstat -ibn`: the `<Link#n>` line of each interface, its Ibytes and Obytes. Counted from the right, as the address may be blank. */
export function parseNetstat(text: string): Counter[] {
  const out: Counter[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const words = line.trim().split(/\s+/)
    if (words.length < 10 || !words[2]?.startsWith('<Link#')) continue
    const name = (words[0] ?? '').replace(/\*$/, '')
    const rx = Number(words[words.length - 5])
    const tx = Number(words[words.length - 2])
    if (!name || seen.has(name) || !Number.isFinite(rx) || !Number.isFinite(tx)) continue
    seen.add(name)
    out.push({ name, rx, tx })
  }
  return out
}

/** `/proc/net/dev`: `name: rx_bytes … (8 fields) tx_bytes …`. */
export function parseProcNetDev(text: string): Counter[] {
  const out: Counter[] = []
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number)
    if (!name || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue
    out.push({ name, rx: fields[0] as number, tx: fields[8] as number })
  }
  return out
}

const WRAP = 2 ** 32

/** How much a counter grew: a 32-bit wrap is counted round, a reset (the interface came back) counts nothing. */
export function grew(before: number, after: number): number {
  if (after >= before) return after - before
  if (before < WRAP && WRAP - before + after < WRAP / 2) return WRAP - before + after
  return 0
}

/** Bytes per second down and up between two readings, over the physical interfaces in both. */
export function rateOf(before: readonly Counter[], after: readonly Counter[], seconds: number): { down: number; up: number } {
  if (!(seconds > 0)) return { down: 0, up: 0 }
  const was = new Map(before.map((one) => [one.name, one]))
  let down = 0
  let up = 0
  for (const one of after) {
    if (!isPhysical(one.name)) continue
    const old = was.get(one.name)
    if (!old) continue
    down += grew(old.rx, one.rx)
    up += grew(old.tx, one.tx)
  }
  return { down: down / seconds, up: up / seconds }
}

/** The physical interfaces that carried anything since they came up. */
export const interfacesOf = (counters: readonly Counter[]): string[] => counters.filter((one) => isPhysical(one.name) && one.rx + one.tx > 0).map((one) => one.name)

/* ------------------------------------------------------------------ *
 * History.
 * ------------------------------------------------------------------ */

export interface NetPoint {
  at: number
  /** Bytes per second. */
  down: number
  up: number
}

/** How far back the history goes. */
export const HISTORY_MS = 5 * 60_000

/** The history with `point` added and anything older than `windowMs` before it dropped. */
export function kept(points: readonly NetPoint[], point: NetPoint, windowMs = HISTORY_MS): NetPoint[] {
  return [...points, point].filter((one) => one.at > point.at - windowMs)
}

/* ------------------------------------------------------------------ *
 * The busiest processes.
 * ------------------------------------------------------------------ */

/** `nettop -P -L 1 -x -J bytes_in,bytes_out`: `name.pid,in,out,` a line; the header and lines that do not read are skipped. */
export function parseNettop(text: string): Map<number, { name: string; rx: number; tx: number }> {
  const out = new Map<number, { name: string; rx: number; tx: number }>()
  for (const line of text.split('\n')) {
    const match = /^(.*)\.(\d+),(\d+),(\d+),?\s*$/.exec(line)
    if (!match) continue
    out.set(Number(match[2]), { name: match[1] ?? '', rx: Number(match[3]), tx: Number(match[4]) })
  }
  return out
}

/** `ps -A -o pid=,ppid=,comm=`: each process's parent and executable (never its arguments). */
export function parseComm(text: string): Map<number, { ppid: number; comm: string }> {
  const out = new Map<number, { ppid: number; comm: string }>()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) out.set(Number(match[1]), { ppid: Number(match[2]), comm: (match[3] ?? '').trim() })
  }
  return out
}

/** Who a process belongs to: the nearest agent CLI or Kehikot module (`owners`: pid → module id) above it, itself included; null when neither. */
export function ownerOf(pid: number, procs: ReadonlyMap<number, { ppid: number; comm: string }>, owners: ReadonlyMap<number, string>): { kind: 'module' | 'agent'; name: string } | null {
  let at = pid
  for (let step = 0; step < 40 && at > 1; step++) {
    /* An agent session first: one a module started is still the session's, not the module's. */
    const proc = procs.get(at)
    const agent = proc ? AGENT.exec(proc.comm.split('/').pop() ?? '') : null
    if (agent) return { kind: 'agent', name: agent[1] as string }
    const module = owners.get(at)
    if (module) return { kind: 'module', name: nameOf(module) }
    if (!proc) return null
    at = proc.ppid
  }
  return null
}

export interface TopProc {
  pid: number
  /** The executable's name as nettop says it (cut to 15 characters by macOS). */
  name: string
  /** Bytes per second. */
  down: number
  up: number
  /** The Kehikot module or agent session it belongs to, when Monitor can tell. */
  owner: { kind: 'module' | 'agent'; name: string } | null
}

/** The busiest processes between two nettop readings, the busiest first; a process new since the first is left out. */
export function topOf(
  before: ReadonlyMap<number, { name: string; rx: number; tx: number }>,
  after: ReadonlyMap<number, { name: string; rx: number; tx: number }>,
  seconds: number,
  most = 5,
): Omit<TopProc, 'owner'>[] {
  if (!(seconds > 0)) return []
  const out: Omit<TopProc, 'owner'>[] = []
  for (const [pid, now] of after) {
    const was = before.get(pid)
    if (!was || was.name !== now.name) continue
    const down = grew(was.rx, now.rx) / seconds
    const up = grew(was.tx, now.tx) / seconds
    if (down + up > 0) out.push({ pid, name: now.name, down, up })
  }
  return out.sort((a, b) => b.down + b.up - (a.down + a.up)).slice(0, most)
}

/* ------------------------------------------------------------------ *
 * What the server sends.
 * ------------------------------------------------------------------ */

export interface NetSnapshot {
  /** When the last reading was taken; 0 before the first. */
  at: number
  /** Seconds between readings. */
  every: number
  /** The current rate, bytes per second; null until two readings are held. */
  down: number | null
  up: number | null
  /** The history, oldest first, over `HISTORY_MS`. */
  points: NetPoint[]
  /** The physical interfaces counted. */
  interfaces: string[]
  /** The busiest processes, when this computer can say (macOS); null when it cannot. */
  top: TopProc[] | null
  /** A sentence when the counters could not be read. */
  why: string
}

export const emptyNet = (): NetSnapshot => ({ at: 0, every: 2, down: null, up: null, points: [], interfaces: [], top: null, why: '' })

/* ------------------------------------------------------------------ *
 * Sentences.
 * ------------------------------------------------------------------ */

/** "0 B/s", "820 B/s", "120 kB/s", "2.4 MB/s", "1.1 GB/s": decimal units, one decimal under ten. */
export function rateSaid(bytesPerSecond: number): string {
  const n = Math.max(0, bytesPerSecond || 0)
  const one = (value: number, unit: string) => `${value < 9.95 ? Math.round(value * 10) / 10 : Math.round(value)} ${unit}`
  if (n < 1e3) return `${Math.round(n)} B/s`
  if (n < 1e6) return one(n / 1e3, 'kB/s')
  if (n < 1e9) return one(n / 1e6, 'MB/s')
  return one(n / 1e9, 'GB/s')
}

/** "↓ 2.4 MB/s · ↑ 120 kB/s"; '' before two readings. */
export function ratesSaid(net: Pick<NetSnapshot, 'down' | 'up'>): string {
  if (net.down === null || net.up === null) return ''
  return `↓ ${rateSaid(net.down)} · ↑ ${rateSaid(net.up)}`
}

/** The chart's sentence, for a screen reader. */
export function networkChartSaid(net: NetSnapshot): string {
  if (net.down === null || net.up === null) return 'Network: measuring…'
  const peak = peakOf(net.points)
  return `This computer downloads ${rateSaid(net.down)} and uploads ${rateSaid(net.up)} now; over the last ${Math.max(1, Math.round(spanOf(net.points) / 60_000))} min the most was ${rateSaid(peak.down)} down and ${rateSaid(peak.up)} up.`
}

export const peakOf = (points: readonly NetPoint[]): { down: number; up: number } => ({
  down: Math.max(0, ...points.map((one) => one.down)),
  up: Math.max(0, ...points.map((one) => one.up)),
})

const spanOf = (points: readonly NetPoint[]): number => (points.length > 1 ? (points.at(-1) as NetPoint).at - (points[0] as NetPoint).at : 0)

const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, one) => sum + one, 0) / values.length : 0)

/** A busy process as words: "zen: ↓ 1.2 MB/s · ↑ 4 kB/s (agent session: claude)". */
export function topSaid(one: TopProc): string {
  const whose = one.owner ? ` (${one.owner.kind === 'agent' ? `agent session: ${one.owner.name}` : `Kehikot module: ${one.owner.name}`})` : ''
  return `${one.name}: ${ratesSaid(one)}${whose}`
}

/**
 * The `health` tool's `network` view: the rate now, the history in minute-long steps with its peak,
 * and the busiest processes when this computer can say them.
 */
export function networkSaid(net: NetSnapshot, now: number): string {
  if (!net.at) return net.why || 'Monitor has not read the network yet. Ask again in a few seconds.'
  if (net.down === null || net.up === null) return net.why || `Monitor has read the network once; the rate comes with the next reading, in ${net.every} s. Ask again.`
  const lines: string[] = [
    `This computer's network now: download ${rateSaid(net.down)}, upload ${rateSaid(net.up)} (${net.interfaces.length ? net.interfaces.join(', ') : 'no interface carrying anything'}; loopback and virtual interfaces left out).`,
  ]
  const peak = peakOf(net.points)
  lines.push('', `The last ${Math.max(1, Math.round(spanOf(net.points) / 60_000))} min, read every ${net.every} s; the most was ${rateSaid(peak.down)} down and ${rateSaid(peak.up)} up. Each minute's average, the newest last:`)
  const minutes: string[] = []
  for (let back = Math.ceil(HISTORY_MS / 60_000) - 1; back >= 0; back--) {
    const from = now - (back + 1) * 60_000
    const to = now - back * 60_000
    const inside = net.points.filter((one) => one.at > from && one.at <= to)
    if (!inside.length) continue
    minutes.push(`- ${back === 0 ? 'the last minute' : `${back + 1}–${back} min ago`}: ↓ ${rateSaid(mean(inside.map((one) => one.down)))} · ↑ ${rateSaid(mean(inside.map((one) => one.up)))}`)
  }
  lines.push(...(minutes.length ? minutes : ['- none yet']))
  if (net.top) {
    lines.push('', net.top.length ? 'The busiest processes on external interfaces:' : 'No process moved bytes on an external interface in the last reading.')
    lines.push(...net.top.map((one) => `- ${topSaid(one)}`))
  }
  if (net.why) lines.push('', net.why)
  return lines.join('\n')
}
