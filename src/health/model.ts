import { TRAFFIC_HOST_BY, type TrafficCall } from 'kehikot-module-protocol'

import { callerName, callerOf, spoken, type Caller } from '../traffic/model.ts'

/**
 * The health of Kehikot and its modules on this computer, as plain values. Pure and shared by the
 * page, the server's sampler (`health/sampler.ts`) and the `health` tool: how a `ps` line or an
 * `lsof` line is read, how a process tree is summed, how a log's start markers are counted, how the
 * traffic record's times become percentiles, which module is the worst, and every sentence said.
 *
 * Nothing here reads a file's contents but a module log's start markers and the registry's address,
 * and nothing is kept: the server holds a short ring of samples in memory, and that is all.
 */

/* ------------------------------------------------------------------ *
 * Processes: `ps` and `lsof`, read.
 * ------------------------------------------------------------------ */

export interface Proc {
  pid: number
  ppid: number
  /** Resident memory, in bytes. */
  rss: number
  /** CPU time used since the process started, in seconds. */
  cpu: number
}

/** `ps`'s `time` column: `M:SS.ss`, `H:MM:SS.ss` or `D-HH:MM:SS`, as seconds. NaN when it is none of those. */
export function cpuSeconds(text: string): number {
  const [days, rest] = text.includes('-') ? [Number(text.split('-')[0]), text.split('-')[1] ?? ''] : [0, text]
  const parts = rest.split(':').map(Number)
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return NaN
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return days * 86_400 + seconds
}

/** `ps -A -o pid=,ppid=,rss=,time=`: one process a line, rss in KiB. Lines that do not read are skipped. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/)
    const proc = { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, cpu: cpuSeconds(time ?? '') }
    if (Number.isInteger(proc.pid) && proc.pid > 0 && Number.isInteger(proc.ppid) && Number.isFinite(proc.rss) && Number.isFinite(proc.cpu)) out.push(proc)
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: which pid listens on which port. The first listener of a port wins. */
export function parseListeners(text: string): Map<number, number> {
  const out = new Map<number, number>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port > 0 && !out.has(port)) out.set(port, pid)
    }
  }
  return out
}

/** A process and everything it started, as pids: what one module costs is its server and its children. A pid in `others` is another module's, and is left out with its own children. */
export function treeOf(root: number, procs: readonly Proc[], others: ReadonlySet<number> = new Set()): number[] {
  const children = new Map<number, number[]>()
  for (const proc of procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
  const out: number[] = []
  const queue = [root]
  while (queue.length && out.length < 200) {
    const pid = queue.shift() as number
    if (out.includes(pid) || (pid !== root && others.has(pid))) continue
    out.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Restarts: the host's start markers in a module's log.
 * ------------------------------------------------------------------ */

/** The line the host writes at every start of a module (`openRun` in the host's moduleLog.ts). */
export const RUN_MARK = '--- kehikko started this at '

/**
 * What ended a run badly, in the lines printed before the next start: Bun's own crash banner, a
 * process that exited with a code other than 0, or a signal other than the host's own stop
 * (SIGTERM, exit 143) and Ctrl-C (SIGINT, 130).
 */
const CRASHED = /Bun has crashed|panic\(|exited with code (?!0\b|143\b|130\b)\d+|due to signal (?!SIGTERM|SIGINT)SIG[A-Z]+|Segmentation fault/

/** A build that failed (at install or update) is not a run that crashed. */
const BUILD = /script "build"|\bbuild\b.*exited/

/**
 * The host builds an installed module when it installs or updates it (`runBuild` in the host's
 * moduleBuilds.ts) and writes the build's output between these two lines. A start after one is a
 * start after an update, and nothing printed in between is a crash of the module.
 */
export const BUILD_MARK = '--- kehikko built this at '
const BUILD_END = /^--- the build (finished|did not finish) after /

export interface Starts {
  /** Every start in the log, ms since the epoch, oldest first. */
  starts: number[]
  /** Starts whose run before them ended in a crash: the time of the start that followed the crash. */
  crashes: number[]
  /** Starts with a build of the module (an install or an update) since the start before. */
  updates: number[]
}

/**
 * The starts and crashes one log says. Only the host's marker lines and the crash patterns are
 * looked at; nothing else of the log is kept or said.
 */
export function startsIn(log: string, endedAt: number = Number.MAX_SAFE_INTEGER): Starts {
  const starts: number[] = []
  const crashes: number[] = []
  const updates: number[] = []
  let crashed = false
  let built = false
  let building = false
  for (const line of log.split('\n')) {
    if (line.startsWith(RUN_MARK)) {
      const at = Date.parse(line.slice(RUN_MARK.length).replace(/\s*-+\s*$/, ''))
      if (Number.isFinite(at)) {
        if (crashed && starts.length) crashes.push(at)
        else if (built) updates.push(at)
        starts.push(at)
      }
      crashed = false
      built = false
      building = false
    } else if (line.startsWith(BUILD_MARK)) {
      built = true
      building = true
    } else if (BUILD_END.test(line)) building = false
    else if (!building && !crashed && CRASHED.test(line) && !BUILD.test(line)) crashed = true
  }
  /* A crash after the last start, with no start since: the module is down after crashing, since the log was last written (`endedAt`). */
  if (crashed && starts.length) crashes.push(endedAt)
  return { starts, crashes, updates }
}

/** Starts of several modules this close together are Kehikot starting them: the app or the host starting. */
export const TOGETHER_MS = 90_000
/** How many other modules must start that close for a start to be Kehikot's. */
export const TOGETHER_OTHERS = 2
/** Repeated starts are worth a look when this many fall in `BURST_MS`. */
export const BURST_MIN = 3
export const BURST_MS = 10 * 60_000

/**
 * The starts one log gives no reason for: not after a crash, not after an update, and not while
 * other modules started too (Kehikot or the app starting, or restarting to update). What is left
 * is a person's restart, Kehikot starting it for an open kehikko, or a process that ended without
 * saying why; only a burst of them is worth a look.
 */
export function unexplained(own: Starts, others: readonly Starts[]): number[] {
  const explained = new Set([...own.crashes, ...own.updates])
  return own.starts.filter((at) => {
    if (explained.has(at)) return false
    let together = 0
    for (const other of others) {
      if (other.starts.some((then) => Math.abs(then - at) <= TOGETHER_MS)) together++
      if (together >= TOGETHER_OTHERS) return false
    }
    return true
  })
}

/** The most of `times` (oldest first or not) inside any window of `windowMs`, counting only those at or after `since`. */
export function mostWithin(times: readonly number[], windowMs: number, since = 0): number {
  const sorted = times.filter((at) => at >= since).sort((a, b) => a - b)
  let most = 0
  let from = 0
  for (let to = 0; to < sorted.length; to++) {
    while ((sorted[to] as number) - (sorted[from] as number) > windowMs) from++
    most = Math.max(most, to - from + 1)
  }
  return most
}

/* ------------------------------------------------------------------ *
 * What the server sends: one snapshot.
 * ------------------------------------------------------------------ */

/** One sample of one module's processes. */
export interface Point {
  at: number
  /** CPU used since the sample before, in cores: 1 is one core busy the whole time. */
  cpu: number
  rss: number
}

export interface ModuleHealth {
  /** The registered id, or `kehikko` for Kehikot itself. */
  id: string
  port: number | null
  /** Whether a process answers on its port. */
  running: boolean
  /** Processes in its tree at the last sample. */
  procs: number
  /** The latest sample, null when it is not running or only one sample is held. */
  now: Point | null
  /** The ring of samples, oldest first. */
  points: Point[]
  /** Starts in the last 24 hours, from its log: every kind. */
  starts: number
  /** Of those, the starts after a crash. */
  crashes: number
  /** Of those, the starts after Kehikot built it: an install or an update. */
  updates: number
  /** The last start the log says, ms; null when there is no log. */
  startedAt: number | null
  /** When it crashed in the last 24 hours, oldest first. */
  crashedAt: number[]
  /** Starts in the last 24 hours its log gives no reason for (`unexplained`), oldest first. */
  unexplainedAt: number[]
}

export interface DiskUse {
  label: string
  /** What it is: `kehikot` (the machine folder's parts), `logs`, `worktrees`. */
  kind: 'kehikot' | 'logs' | 'worktrees'
  bytes: number
  /** For worktrees: how many, and how many carry node_modules. */
  count?: number
  withModules?: number
}

export interface Disk {
  at: number | null
  /** The volume the home folder is on: free and total bytes. */
  free: number | null
  total: number | null
  uses: DiskUse[]
  /** A sentence when something could not be measured. */
  why: string
}

export interface Snapshot {
  at: number
  /** The computer's cores and memory, for scale. */
  cores: number
  memory: number
  /** Seconds between samples. */
  every: number
  modules: ModuleHealth[]
  disk: Disk
  /** What Monitor itself costs, from the same sample. */
  self: Point | null
  /** A sentence when something could not be looked at (no `ps`, no registry). */
  why: string
}

export const emptySnapshot = (): Snapshot => ({ at: 0, cores: 1, memory: 0, every: 5, modules: [], disk: { at: null, free: null, total: null, uses: [], why: '' }, self: null, why: '' })

/* ------------------------------------------------------------------ *
 * Latency and errors, from the traffic record.
 * ------------------------------------------------------------------ */

export interface Latency {
  /** Calls with a time, and how many of all calls failed. */
  timed: number
  calls: number
  errors: number
  p50: number | null
  p95: number | null
}

/** The value below which `q` of the sorted numbers fall (nearest rank). */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number
}

/** Whether a call failed: it said so, or its status is an HTTP error, or a command's non-zero exit. */
export function failed(call: TrafficCall): boolean {
  if (call.ok !== null) return !call.ok
  if (call.status === null) return false
  return call.status >= 400 || call.status === -1 || (call.kind !== 'http' && call.kind !== 'mcp' && call.status > 0 && call.status < 100)
}

export function latencyOf(calls: readonly TrafficCall[]): Latency {
  const times = calls.flatMap((call) => (call.ms === null ? [] : [call.ms])).sort((a, b) => a - b)
  return { timed: times.length, calls: calls.length, errors: calls.filter(failed).length, p50: percentile(times, 0.5), p95: percentile(times, 0.95) }
}

export const LATENCY_WINDOW_MS = 5 * 60_000

/** The port a call went to on this computer, when it went to one: `127.0.0.1:9060` → 9060. */
export function localPort(call: TrafficCall): number | null {
  const found = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(call.host)
  return found ? Number(found[1]) : null
}

export interface CallerLatency extends Latency {
  by: Caller
  /** The calls this caller's server answered (made to its port), when it has one. */
  answered: Latency | null
}

/**
 * Per caller, over the last `windowMs`: the calls it made (how long they took, how many failed) and,
 * for a module whose port is known, the calls it answered. Callers with neither are left out.
 */
export function latencies(calls: readonly TrafficCall[], now: number, ports: ReadonlyMap<string, number> = new Map(), windowMs = LATENCY_WINDOW_MS): CallerLatency[] {
  const recent = calls.filter((call) => call.at >= now - windowMs && call.side !== 'seen')
  const made = new Map<Caller, TrafficCall[]>()
  const to = new Map<number, TrafficCall[]>()
  for (const call of recent) {
    const by = callerOf(call)
    made.set(by, [...(made.get(by) ?? []), call])
    const port = localPort(call)
    if (port !== null) to.set(port, [...(to.get(port) ?? []), call])
  }
  const ids = new Set<Caller>([...made.keys(), ...[...ports.keys()].filter((id) => to.has(ports.get(id) as number))])
  return [...ids]
    .map((by) => {
      const port = ports.get(by)
      const answered = port !== undefined && to.has(port) ? latencyOf(to.get(port) as TrafficCall[]) : null
      return { by, ...latencyOf(made.get(by) ?? []), answered }
    })
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
}

/* ------------------------------------------------------------------ *
 * Judging: what is worth a word.
 * ------------------------------------------------------------------ */

export type Level = 'normal' | 'warn' | 'critical'

/** Where a module starts being worth a word. CPU in cores, averaged over the ring; memory in bytes. */
export const LIMITS = {
  cpuWarn: 0.8,
  cpuCritical: 1.5,
  rssWarn: 1024 ** 3,
  rssCritical: 2 * 1024 ** 3,
  p95Warn: 2000,
  p95Critical: 10_000,
  errorWarn: 0.2,
  errorMin: 5,
  freeWarn: 0.1,
  freeCritical: 0.05,
} as const

const HOUR = 60 * 60_000

export const average = (points: readonly Point[]): number => (points.length ? points.reduce((sum, point) => sum + point.cpu, 0) / points.length : 0)

export const percent = (cores: number): string => `${Math.round(cores * 100)}%`

/** A module's name: its registered id, said as Kehikot would (`callerName`). */
export const nameOf = (id: string): string => (id === TRAFFIC_HOST_BY ? 'Kehikot' : callerName(id))

export interface Judged {
  id: string
  name: string
  level: Level
  /** What is wrong, or what it costs when nothing is: one short phrase. */
  said: string
  /** For sorting: CPU in cores. */
  cpu: number
}

/** One module, judged from its processes, its log and its calls. */
export function judge(module: ModuleHealth, latency: CallerLatency | undefined, now: number): Judged {
  const name = nameOf(module.id)
  const cpu = average(module.points.slice(-6))
  const rss = module.now?.rss ?? 0
  const found: Array<{ level: Level; said: string }> = []
  const lately = now - HOUR
  const crashed = module.crashedAt.filter((at) => at >= lately).length
  if (crashed) {
    const burst = mostWithin(module.crashedAt, BURST_MS, lately)
    const said = !module.running ? 'down after a crash' : burst >= BURST_MIN ? `crashed ${burst} times in ${spoken(BURST_MS)}` : crashed > 1 ? `crashed ${crashed} times in the last hour` : 'crashed in the last hour'
    found.push({ level: 'critical', said })
  }
  if (cpu >= LIMITS.cpuCritical) found.push({ level: 'critical', said: `${percent(cpu)} CPU` })
  else if (cpu >= LIMITS.cpuWarn) found.push({ level: 'warn', said: `${percent(cpu)} CPU` })
  if (rss >= LIMITS.rssCritical) found.push({ level: 'critical', said: `${sizeSaid(rss)} memory` })
  else if (rss >= LIMITS.rssWarn) found.push({ level: 'warn', said: `${sizeSaid(rss)} memory` })
  const slowest = Math.max(latency?.p95 ?? 0, latency?.answered?.p95 ?? 0)
  if (slowest >= LIMITS.p95Critical) found.push({ level: 'critical', said: `calls take ${msSaid(slowest)} (p95)` })
  else if (slowest >= LIMITS.p95Warn) found.push({ level: 'warn', said: `calls take ${msSaid(slowest)} (p95)` })
  for (const one of [latency, latency?.answered]) {
    if (one && one.calls >= LIMITS.errorMin && one.errors / one.calls >= LIMITS.errorWarn) {
      found.push({ level: 'warn', said: `${percent(one.errors / one.calls)} of calls fail` })
      break
    }
  }
  /* Starts after an update, a restart or Kehikot starting are not news; only a burst nothing explains is. */
  const odd = mostWithin(module.unexplainedAt, BURST_MS, lately)
  if (odd >= BURST_MIN) found.push({ level: 'warn', said: `started ${odd} times in ${spoken(BURST_MS)}, no update or crash in its log` })
  const worst = found.find((one) => one.level === 'critical') ?? found[0]
  if (worst) return { id: module.id, name, level: worst.level, said: worst.said, cpu }
  return { id: module.id, name, level: 'normal', said: module.running ? `${percent(cpu)} CPU, ${sizeSaid(rss)}` : 'not running', cpu }
}

const RANK: Record<Level, number> = { normal: 0, warn: 1, critical: 2 }

/** Every module judged, the worst first; among equals, the busiest first. */
export function judged(snapshot: Snapshot, lat: readonly CallerLatency[], now: number): Judged[] {
  const by = new Map(lat.map((one) => [one.by, one]))
  return snapshot.modules.map((module) => judge(module, by.get(module.id), now)).sort((a, b) => RANK[b.level] - RANK[a.level] || b.cpu - a.cpu)
}

export interface Totals {
  /** Every running module's and Kehikot's CPU, in cores, and memory, in bytes. */
  cpu: number
  rss: number
  running: number
  registered: number
}

export function totals(snapshot: Snapshot): Totals {
  let cpu = 0
  let rss = 0
  let running = 0
  for (const module of snapshot.modules) {
    if (!module.running) continue
    running++
    cpu += module.now?.cpu ?? 0
    rss += module.now?.rss ?? 0
  }
  return { cpu, rss, running, registered: snapshot.modules.filter((module) => module.id !== TRAFFIC_HOST_BY).length }
}

/** How full the home folder's disk is, judged. */
export function diskLevel(disk: Disk): Level {
  if (disk.free === null || !disk.total) return 'normal'
  const free = disk.free / disk.total
  return free <= LIMITS.freeCritical ? 'critical' : free <= LIMITS.freeWarn ? 'warn' : 'normal'
}

export const freeSaid = (disk: Disk): string => (disk.free === null || !disk.total ? 'free space unknown' : `${sizeSaid(disk.free)} free of ${sizeSaid(disk.total)}`)

/* ------------------------------------------------------------------ *
 * Sentences: the chart's words, the footer's and the tool's.
 * ------------------------------------------------------------------ */

export function cpuSaid(snapshot: Snapshot): string {
  const sum = totals(snapshot)
  return `Kehikot and ${sum.running - (snapshot.modules.some((m) => m.id === TRAFFIC_HOST_BY && m.running) ? 1 : 0)} running modules use ${percent(sum.cpu)} CPU (${percent(sum.cpu / Math.max(1, snapshot.cores))} of ${snapshot.cores} cores).`
}

export function memorySaid(snapshot: Snapshot): string {
  const sum = totals(snapshot)
  return `They hold ${sizeSaid(sum.rss)} of memory${snapshot.memory ? `, ${percent(sum.rss / snapshot.memory)} of this computer's ${sizeSaid(snapshot.memory)}` : ''}.`
}

/** A day's starts, split by why: after an update, after a crash, and the rest (restarts by Kehikot or a person). */
export function restartsOf(modules: readonly Pick<ModuleHealth, 'starts' | 'crashes' | 'updates'>[]): { starts: number; updates: number; crashes: number; restarts: number } {
  const starts = modules.reduce((sum, m) => sum + m.starts, 0)
  const updates = modules.reduce((sum, m) => sum + m.updates, 0)
  const crashes = modules.reduce((sum, m) => sum + m.crashes, 0)
  return { starts, updates, crashes, restarts: Math.max(0, starts - updates - crashes) }
}

const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "3 updates, 5 restarts, no crash": a day's starts by why. */
export const whySaid = (sum: { updates: number; restarts: number; crashes: number }): string =>
  `${counted(sum.updates, 'update')}, ${counted(sum.restarts, 'restart')}, ${sum.crashes ? counted(sum.crashes, 'crash', 'crashes') : 'no crash'}`

export function restartsSaid(snapshot: Snapshot): string {
  const sum = restartsOf(snapshot.modules)
  const most = [...snapshot.modules].sort((a, b) => b.starts - a.starts)[0]
  if (!sum.starts) return 'No module was started in the last 24 hours.'
  return `${sum.starts} starts in the last 24 hours: ${sum.updates} after an update, ${sum.restarts} restarts by Kehikot or a person, ${sum.crashes ? `${sum.crashes} after a crash` : 'none after a crash'}${most && most.starts > 1 ? `; ${nameOf(most.id)} the most, ${most.starts} times` : ''}.`
}

export function diskSaid(disk: Disk): string {
  if (disk.at === null) return disk.why || 'Disk use is being measured.'
  const big = [...disk.uses].sort((a, b) => b.bytes - a.bytes)[0]
  return `${freeSaid(disk)}.${big ? ` The biggest: ${big.label}, ${sizeSaid(big.bytes)}.` : ''}`
}

export function latencySaid(lat: readonly CallerLatency[]): string {
  const slow = lat.find((one) => one.p95 !== null)
  if (!slow) return 'No timed calls in the last 5 minutes.'
  const errors = lat.reduce((sum, one) => sum + one.errors, 0)
  const calls = lat.reduce((sum, one) => sum + one.calls, 0)
  return `Slowest: ${nameOf(slow.by)}, half its calls within ${msSaid(slow.p50 ?? 0)} and 95% within ${msSaid(slow.p95 ?? 0)}. ${errors} of ${calls} calls failed in the last 5 minutes.`
}

/** How long ago, said: "4 min ago". */
export function agoSaid(ms: number, now: number): string {
  const gone = Math.max(0, now - ms)
  if (gone < 60 * 60_000) return `${spoken(gone)} ago`
  if (gone < 48 * 60 * 60_000) return `${Math.round(gone / (60 * 60_000))} h ago`
  return `${Math.round(gone / (24 * 60 * 60_000))} days ago`
}

/** "340 MB", "2.1 GB", "1.4 TB": sizes past what a call carries. */
export function sizeSaid(bytes: number): string {
  if (bytes < 1e9) return bytes < 1e6 ? `${Math.round(bytes / 1e3)} kB` : `${Math.round(bytes / 1e6)} MB`
  if (bytes < 1e12) return `${Math.round(bytes / 1e8) / 10} GB`
  return `${Math.round(bytes / 1e11) / 10} TB`
}

/** "40 ms", "1.2 s": how long a call took. */
export const msSaid = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : spoken(ms))

/* ------------------------------------------------------------------ *
 * The `health` tool's answer.
 * ------------------------------------------------------------------ */

export const HEALTH_VIEWS = ['now', 'processes', 'calls', 'restarts', 'disk'] as const
export type HealthView = (typeof HEALTH_VIEWS)[number]

/**
 * What is slow or heavy right now, as lines an agent reads. `now` (the default) says the worst first
 * and the totals; the others list every module by one measure.
 */
export function healthSaid(snapshot: Snapshot, lat: readonly CallerLatency[], now: number, view: HealthView = 'now', trafficWhy = ''): string {
  if (!snapshot.at) return snapshot.why || 'Monitor has not sampled the processes yet. Ask again in a few seconds.'
  const lines: string[] = []
  const all = judged(snapshot, lat, now)
  const byId = new Map(snapshot.modules.map((m) => [m.id, m]))
  const row = (m: ModuleHealth) => {
    const cpu = average(m.points.slice(-6))
    return `${nameOf(m.id)}${m.id === TRAFFIC_HOST_BY ? '' : ` (${m.id})`}: ${m.running ? `${percent(cpu)} CPU, ${sizeSaid(m.now?.rss ?? 0)}, ${m.procs} ${m.procs === 1 ? 'process' : 'processes'}` : 'not running'}`
  }
  if (view === 'now') {
    lines.push(`${cpuSaid(snapshot)} ${memorySaid(snapshot)}`)
    const flagged = all.filter((one) => one.level !== 'normal')
    lines.push('', flagged.length ? 'Worth a look, the worst first:' : 'Nothing needs a look right now. The busiest:')
    lines.push(...(flagged.length ? flagged : all.filter((one) => byId.get(one.id)?.running).slice(0, 5)).map((one) => `- ${one.name}: ${one.said}${one.level === 'critical' ? ' (critical)' : one.level === 'warn' ? ' (warning)' : ''}`))
    lines.push('', trafficWhy || latencySaid(lat), restartsSaid(snapshot), `Disk: ${snapshot.disk.at === null ? 'being measured.' : diskSaid(snapshot.disk)}`)
  }
  if (view === 'processes') {
    lines.push(`${cpuSaid(snapshot)} ${memorySaid(snapshot)} Sampled every ${snapshot.every} s; CPU is the average of the last 30 seconds.`, '')
    const ordered = [...snapshot.modules].sort((a, b) => average(b.points.slice(-6)) - average(a.points.slice(-6)) || (b.now?.rss ?? 0) - (a.now?.rss ?? 0))
    lines.push(...ordered.map((m) => `- ${row(m)}`))
  }
  if (view === 'calls') {
    lines.push(trafficWhy || 'Each caller’s calls in the last 5 minutes: the time half of them took (p50), the time 95% of them took (p95), and how many failed. "Answered" is the calls made to its own server.', '')
    lines.push(
      ...(lat.length
        ? lat.map((one) => {
            const made = one.calls ? `made ${one.calls}, p50 ${one.p50 === null ? '—' : msSaid(one.p50)}, p95 ${one.p95 === null ? '—' : msSaid(one.p95)}, ${one.errors} failed` : 'made none'
            const answered = one.answered ? `; answered ${one.answered.calls}, p95 ${one.answered.p95 === null ? '—' : msSaid(one.answered.p95)}, ${one.answered.errors} failed` : ''
            return `- ${nameOf(one.by)}: ${made}${answered}`
          })
        : ['- none']),
    )
  }
  if (view === 'restarts') {
    lines.push(restartsSaid(snapshot), '')
    const ordered = [...snapshot.modules].filter((m) => m.id !== TRAFFIC_HOST_BY).sort((a, b) => b.crashes - a.crashes || b.starts - a.starts)
    lines.push(
      ...ordered.map(
        (m) => `- ${nameOf(m.id)}: ${m.starts} starts today (${whySaid({ updates: m.updates, crashes: m.crashes, restarts: Math.max(0, m.starts - m.updates - m.crashes) })})${m.startedAt ? `, last started ${agoSaid(m.startedAt, now)}` : ', no log'}${m.running ? '' : ', not running'}`,
      ),
    )
  }
  if (view === 'disk') {
    lines.push(diskSaid(snapshot.disk))
    if (snapshot.disk.at !== null) lines.push(`Measured ${agoSaid(snapshot.disk.at, now)}; sizes only, every 30 minutes while Monitor is watched.`)
    if (snapshot.disk.why) lines.push(snapshot.disk.why)
    lines.push('', ...snapshot.disk.uses.map((use) => `- ${use.label}: ${sizeSaid(use.bytes)}${use.count !== undefined ? `, ${use.count} worktrees, ${use.withModules} with node_modules` : ''}`))
  }
  if (snapshot.self) lines.push('', `Monitor itself: ${percent(snapshot.self.cpu)} CPU, ${sizeSaid(snapshot.self.rss)}.`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * The page: what its charts draw, and how much it shows for its size.
 * ------------------------------------------------------------------ */

/** Every module's CPU and memory added up at each sample, oldest first: the glance charts' line. */
export function totalsOver(snapshot: Snapshot): Array<{ at: number; cpu: number; rss: number }> {
  const at = new Map<number, { at: number; cpu: number; rss: number }>()
  for (const module of snapshot.modules) {
    for (const point of module.points) {
      const one = at.get(point.at) ?? { at: point.at, cpu: 0, rss: 0 }
      one.cpu += point.cpu
      one.rss += point.rss
      at.set(point.at, one)
    }
  }
  return [...at.values()].sort((a, b) => a.at - b.at)
}

export interface Box {
  width: number
  height: number
}

/**
 * How much the Health view shows, from its container's own size (as Test runs does):
 * - `glance` — under 240 px tall: the tiles only.
 * - `list`   — under 380 px wide or 400 px tall: the tiles and the modules worth a look.
 * - `full`   — the tiles, every running module in a table, and the disk.
 */
export type Detail = 'glance' | 'list' | 'full'

export function detailOf(box: Box | null): Detail {
  if (!box) return 'full'
  if (box.height < 240) return 'glance'
  if (box.width < 380 || box.height < 400) return 'list'
  return 'full'
}

/** Worktree folders, added up: how many, how many with node_modules, and their size so far. */
export function worktreesOf(disk: Disk): { count: number; withModules: number; bytes: number; roots: number } {
  const roots = disk.uses.filter((use) => use.kind === 'worktrees')
  return {
    count: roots.reduce((sum, use) => sum + (use.count ?? 0), 0),
    withModules: roots.reduce((sum, use) => sum + (use.withModules ?? 0), 0),
    bytes: roots.reduce((sum, use) => sum + use.bytes, 0),
    roots: roots.length,
  }
}
