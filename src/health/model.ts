import { TRAFFIC_HOST_BY } from 'kehikot-module-protocol'

import { callerName, spoken } from '../traffic/model.ts'
import { outsideSaid, type Outside } from './heavy.ts'

/**
 * The health of Kehikot and its modules on this computer, as plain values. Pure and shared by the
 * page, the server's sampler (`health/sampler.ts`) and the `health` tool: how a `ps` line or an
 * `lsof` line is read, how a process tree is summed, how a log's start markers are counted, which module is the worst, and every sentence said.
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
 * Crashes: the host's start markers and crash lines in a module's log.
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

/**
 * The crashes one log says: the time of the start that followed each crash, or `endedAt` for a
 * module that is down after one. Only the host's marker lines and the crash patterns are looked at;
 * nothing else of the log is kept or said.
 */
export function crashesIn(log: string, endedAt: number = Number.MAX_SAFE_INTEGER): number[] {
  const crashes: number[] = []
  let starts = 0
  let crashed = false
  let building = false
  for (const line of log.split('\n')) {
    if (line.startsWith(RUN_MARK)) {
      const at = Date.parse(line.slice(RUN_MARK.length).replace(/\s*-+\s*$/, ''))
      if (Number.isFinite(at)) {
        if (crashed && starts) crashes.push(at)
        starts++
      }
      crashed = false
      building = false
    } else if (line.startsWith(BUILD_MARK)) building = true
    else if (BUILD_END.test(line)) building = false
    else if (!building && !crashed && CRASHED.test(line) && !BUILD.test(line)) crashed = true
  }
  /* A crash after the last start, with no start since: the module is down after crashing, since the log was last written (`endedAt`). */
  if (crashed && starts) crashes.push(endedAt)
  return crashes
}

/** Crashes are worth a look when this many fall in `BURST_MS`. */
export const BURST_MIN = 3
export const BURST_MS = 10 * 60_000

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
  /** When it crashed in the last 24 hours, oldest first. */
  crashedAt: number[]
}

export interface Snapshot {
  at: number
  /** The computer's cores and memory, for scale. */
  cores: number
  memory: number
  /** Seconds between samples. */
  every: number
  modules: ModuleHealth[]
  /** What Monitor itself costs, from the same sample. */
  self: Point | null
  /** A sentence when something could not be looked at (no `ps`, no registry). */
  why: string
  /** Heavy work agent sessions started outside the Queue; absent from an older server. */
  outside?: Outside[]
}

export const emptySnapshot = (): Snapshot => ({ at: 0, cores: 1, memory: 0, every: 5, modules: [], self: null, why: '' })

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

/** One module, judged from its processes and its log. */
export function judge(module: ModuleHealth, now: number): Judged {
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
  const worst = found.find((one) => one.level === 'critical') ?? found[0]
  if (worst) return { id: module.id, name, level: worst.level, said: worst.said, cpu }
  return { id: module.id, name, level: 'normal', said: module.running ? `${percent(cpu)} CPU, ${sizeSaid(rss)}` : 'not running', cpu }
}

const RANK: Record<Level, number> = { normal: 0, warn: 1, critical: 2 }

/** Every module judged, the worst first; among equals, the busiest first. */
export function judged(snapshot: Snapshot, now: number): Judged[] {
  return snapshot.modules.map((module) => judge(module, now)).sort((a, b) => RANK[b.level] - RANK[a.level] || b.cpu - a.cpu)
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

/**
 * The one quiet line for a module that crashed in the last hour, said in words; '' when none did.
 * This is all Health says about crashes: what ended in a crash, never a count of starts.
 */
export function crashesSaid(snapshot: Snapshot, now: number): string {
  const lately = now - HOUR
  const said = snapshot.modules.flatMap((module) => {
    const crashed = module.crashedAt.filter((at) => at >= lately).length
    if (!crashed) return []
    const burst = mostWithin(module.crashedAt, BURST_MS, lately)
    const how = !module.running ? 'is down after a crash' : burst >= BURST_MIN ? `crashed ${burst} times in ${spoken(BURST_MS)}` : crashed > 1 ? `crashed ${crashed} times in the last hour` : 'crashed in the last hour'
    return [`${nameOf(module.id)} ${how}`]
  })
  return said.join('; ')
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

/* ------------------------------------------------------------------ *
 * The `health` tool's answer.
 * ------------------------------------------------------------------ */

export const HEALTH_VIEWS = ['now', 'processes'] as const

/** Views an older agent may still ask for. */
export const GONE_VIEWS = ['calls', 'restarts', 'disk'] as const
export function goneSaid(view: string): string {
  if (view === 'disk') return 'Health no longer measures the disk: what worktrees take, and cleaning them up, moved to the Worktrees module (its worktrees tool). Health keeps CPU and memory.'
  return `Health no longer tracks ${view === 'calls' ? 'call times or failures' : 'restarts'}. ${view === 'calls' ? 'The traffic tool has the calls.' : 'It says only a module that crashed in the last hour: see now.'}`
}
export type HealthView = (typeof HEALTH_VIEWS)[number]

/**
 * What is slow or heavy right now, as lines an agent reads. `now` (the default) says the worst first
 * and the totals; `processes` lists every module.
 */
export function healthSaid(snapshot: Snapshot, now: number, view: HealthView = 'now'): string {
  if (!snapshot.at) return snapshot.why || 'Monitor has not sampled the processes yet. Ask again in a few seconds.'
  const lines: string[] = []
  const all = judged(snapshot, now)
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
    const crashed = crashesSaid(snapshot, now)
    const outside = outsideSaid(snapshot.outside ?? [])
    if (crashed || outside) lines.push('', ...(crashed ? [`${crashed}.`] : []), ...(outside ? [`${outside}.`] : []))
  }
  if (view === 'processes') {
    lines.push(`${cpuSaid(snapshot)} ${memorySaid(snapshot)} Sampled every ${snapshot.every} s; CPU is the average of the last 30 seconds.`, '')
    const ordered = [...snapshot.modules].sort((a, b) => average(b.points.slice(-6)) - average(a.points.slice(-6)) || (b.now?.rss ?? 0) - (a.now?.rss ?? 0))
    lines.push(...ordered.map((m) => `- ${row(m)}`))
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
 * - `full`   — the tiles, and every running module in a table.
 */
export type Detail = 'glance' | 'list' | 'full'

export function detailOf(box: Box | null): Detail {
  if (!box) return 'full'
  if (box.height < 240) return 'glance'
  if (box.width < 380 || box.height < 400) return 'list'
  return 'full'
}
