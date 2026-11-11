import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus, homedir, totalmem } from 'node:os'
import { join } from 'node:path'

import { TRAFFIC_HOST_BY, WORK_QUEUE, providerOf, type WorkQueue } from 'kehikot-module-protocol'
import { askHost } from 'kehikot-module-protocol/serve'

import { ID } from '../manifest.ts'
import { heavyOutside, parseProcLines, sessionFrom, type Outside } from '../src/health/heavy.ts'
import { Told } from '../src/health/tell.ts'
import { crashesIn, parseListeners, parsePs, treeOf, type ModuleHealth, type Point, type Proc, type Snapshot } from '../src/health/model.ts'

/**
 * The health of the processes Kehikot runs on this computer, sampled by Monitor's server.
 *
 * ## Only while somebody looks
 *
 * Nothing runs until the page or the `health` tool asks (`snapshot`). Then a sample is taken every
 * `EVERY_MS` for `WATCH_MS` after the last ask, and nothing after that: Monitor folded away, or not on
 * any canvas, costs nothing. What is held is a ring of `RING` samples per module, in memory.
 *
 * ## What is looked at
 *
 * - `ps -A -o pid=,ppid=,rss=,time=` every sample: each process's memory and CPU time. CPU is the
 *   time used between two samples, summed over a module's server and everything it started.
 * - `lsof -nP -iTCP -sTCP:LISTEN -Fpn` every `LISTEN_MS`, or sooner when a server's pid is gone:
 *   which pid answers on each registered port.
 * - The registry's file names and each one's `url` (the port), every `REGISTRY_MS`.
 * - Each module's log under the logs folder, every `LOGS_MS` and only when its size or time
 *   changed: the host's start markers and crash lines (`crashesIn`). Nothing else of it is kept.
 * - `ps -A -o pid=,ppid=,pcpu=,args=` every `HEAVY_MS`: heavy work an agent session started on its
 *   own, outside the provider of heavy work in turn here if there is one (`services.find`, every `PROVIDER_MS`: its
 *   descriptor's `marks` say which runs are in turn). Each command line is classified into one word
 *   (`heavyWord`) and dropped; for a process so flagged, its `ps -E` once, for the agent CLI's session
 *   variable alone.
 * - With a provider of heavy work in turn here and the person's "Tell agents" on, the session that started it is told once
 *   (`messages.notifySession`, `src/health/tell.ts`), with its own command line, shortened, in the body.
 *
 * Nothing on the disk is measured: what worktrees and folders take is the Worktrees module's, since Monitor 0.14.0.
 *
 * Nothing is written anywhere.
 */

export const EVERY_MS = 5_000
export const WATCH_MS = 30_000
export const RING = 60
export const LISTEN_MS = 15_000
export const REGISTRY_MS = 30_000
export const LOGS_MS = 60_000
/** How often heavy work agent sessions started on their own is looked for (`src/health/heavy.ts`). */
export const HEAVY_MS = 15_000
/** How often the host is asked who provides the provider of heavy work in turn here. */
export const PROVIDER_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

export interface Deps {
  run: (file: string, args: string[], timeoutMs: number) => Promise<string>
  now: () => number
  env: Record<string, string | undefined>
  home: string
  cores: number
  memory: number
  pid: number
  /** A question to the host from this server (`askHost`): who provides a service, and a notice to one session. */
  ask?: (method: 'services.find' | 'messages.notifySession', params: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown }>
}

/* Deps without `ask` (a test's) never reach a host. */
const asksNothing: NonNullable<Deps['ask']> = async () => ({ ok: false })
const askTheHost: NonNullable<Deps['ask']> = (method, params) => askHost(method, params as never, { module: ID }) as Promise<{ ok: boolean; data?: unknown }>

const run: Deps['run'] = (file, args, timeoutMs) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) =>
      /* du and lsof exit non-zero when one path or one process cannot be read, with the rest still said. */
      error && !stdout ? reject(error) : resolve(stdout),
    ),
  )

export const DEPS: Deps = {
  run,
  now: () => Date.now(),
  env: process.env,
  home: homedir(), // kehikot-storage: allow read-only: where Kehikot's module registry and its logs are
  cores: cpus().length || 1,
  memory: totalmem(),
  pid: process.pid,
  ask: askTheHost,
}

/** Kehikot's machine folder, its registry and its logs, as the host spells them (`KEHIKOT_*`, else the defaults). */
export function places(deps: Pick<Deps, 'env' | 'home'>) {
  const machine = join(deps.home, 'Library', 'Application Support', 'Kehikot')
  return {
    machine,
    registry: deps.env.KEHIKOT_MODULES_DIR || join(machine, 'modules'),
    logs: deps.env.KEHIKOT_LOGS_DIR || join(deps.home, 'Library', 'Logs', 'Kehikot'),
  }
}

/** The registered modules and their ports, from the registry's file names and each one's `url`. */
export function registered(dir: string): Map<string, number | null> {
  const out = new Map<string, number | null>()
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const id = name.slice(0, -5).replace(/^roadmap\./, 'kehikot.')
    let port: number | null = null
    try {
      const url = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { url?: unknown }).url
      if (typeof url === 'string') port = Number(new URL(url).port) || null
    } catch {
      /* A registration that does not read still names a module: shown as not running. */
    }
    out.set(id, port)
  }
  return out
}

/** The host's ports, from the origins it hands the modules it starts. */
export function hostPorts(env: Record<string, string | undefined>): number[] {
  const said = [env.KEHIKOT_ORIGINS, env.KEHIKOT_ORIGIN].filter(Boolean).join(',')
  const out: number[] = []
  for (const one of said.split(/[,\s]+/)) {
    try {
      const port = Number(new URL(one).port)
      if (port && !out.includes(port)) out.push(port)
    } catch {
      /* Not an origin. */
    }
  }
  return out
}

export class Sampler {
  private readonly deps: Deps
  private watchedUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private sampling: Promise<void> | null = null
  private lastSample = 0
  private why = ''

  private modules = new Map<string, number | null>()
  private registryAt = 0
  private listeners = new Map<number, number>()
  private listenAt = 0
  private procs: Proc[] = []
  private cpuBefore = new Map<number, number>()
  private sampleBefore = 0
  private rings = new Map<string, Point[]>()
  private trees = new Map<string, number>()
  private selfPoint: Point | null = null

  private logs = new Map<string, { size: number; mtime: number; crashes: number[] }>()
  private logsAt = 0

  private outside: Outside[] = []
  private heavyAt = 0
  /** The session of each flagged pid, read once: a pid's environment does not change. */
  private sessions = new Map<number, string | null>()
  /** The provider of heavy work in turn here, as its provider describes it; null when none is (or the host is too old to say). */
  private provider: WorkQueue | null = null
  private providerAt = 0
  /** The person's "Tell agents", as the page last said it; on until it says otherwise. */
  private tell = true
  private readonly told = new Told()

  constructor(deps: Deps = DEPS) {
    this.deps = deps
  }

  /** Somebody looked: keep sampling for a while, take a sample if the last is stale, and say what is held. `tell`: the page's "Tell agents", when it says. */
  async snapshot(tell?: boolean): Promise<Snapshot> {
    if (tell !== undefined) this.tell = tell
    const now = this.deps.now()
    this.watchedUntil = now + WATCH_MS
    if (now - this.lastSample >= EVERY_MS - 500) await this.sample()
    this.schedule()
    return this.said()
  }

  /** Stop the timer: for the tests, and for a server that stops. */
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
    this.timer = setTimeout(tick, EVERY_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** One sample; concurrent askers share it. */
  sample(): Promise<void> {
    if (!this.sampling) this.sampling = this.take().finally(() => (this.sampling = null))
    return this.sampling
  }

  private async take(): Promise<void> {
    const { deps } = this
    const now = deps.now()
    const where = places(deps)
    if (now - this.registryAt >= REGISTRY_MS || !this.registryAt) {
      this.modules = registered(where.registry)
      const host = hostPorts(deps.env)
      if (host.length) this.modules.set(TRAFFIC_HOST_BY, host[0] as number)
      this.registryAt = now
      this.hostPorts = host
    }
    try {
      this.procs = parsePs(await deps.run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], 5_000))
      this.why = ''
    } catch (error) {
      this.why = `Monitor could not list this computer's processes: ${error instanceof Error ? error.message : String(error)}`
      this.lastSample = now
      return
    }
    const alive = new Set(this.procs.map((proc) => proc.pid))
    const lost = [...this.listeners.values()].some((pid) => !alive.has(pid))
    if (now - this.listenAt >= LISTEN_MS || lost || !this.listenAt) {
      try {
        this.listeners = parseListeners(await deps.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], 5_000))
      } catch {
        this.listeners = new Map()
      }
      this.listenAt = now
    }
    const seconds = this.sampleBefore ? (now - this.sampleBefore) / 1000 : 0
    const byPid = new Map(this.procs.map((proc) => [proc.pid, proc]))
    /* Kehikot starts the modules, so its tree holds theirs: each module's processes are counted once, under the module. */
    const roots = new Map<string, number>()
    for (const [id, port] of this.modules) {
      const pid = port === null ? undefined : this.portPid(id, port)
      if (pid !== undefined) roots.set(id, pid)
    }
    const moduleRoots = new Set([...roots].filter(([id]) => id !== TRAFFIC_HOST_BY).map(([, pid]) => pid))
    const treeFor = (root: number) => treeOf(root, this.procs, moduleRoots)
    const cost = (root: number): Point | null => {
      if (!seconds) return null
      let cpu = 0
      let rss = 0
      for (const pid of treeFor(root)) {
        const proc = byPid.get(pid)
        if (!proc) continue
        rss += proc.rss
        const before = this.cpuBefore.get(pid)
        /* A process new since the last sample is left out of this one's CPU: its total is since it started. */
        if (before !== undefined) cpu += Math.max(0, proc.cpu - before)
      }
      return { at: now, cpu: cpu / seconds, rss }
    }
    for (const id of this.modules.keys()) {
      const pid = roots.get(id)
      const ring = this.rings.get(id) ?? []
      if (pid === undefined) {
        this.trees.delete(id)
        this.rings.set(id, [])
        continue
      }
      this.trees.set(id, treeFor(pid).length)
      const point = cost(pid)
      if (point) ring.push(point)
      this.rings.set(id, ring.slice(-RING))
    }
    for (const id of [...this.rings.keys()]) if (!this.modules.has(id)) this.rings.delete(id)
    this.selfPoint = cost(deps.pid) ?? this.selfPoint
    this.cpuBefore = new Map(this.procs.map((proc) => [proc.pid, proc.cpu]))
    this.sampleBefore = now
    this.lastSample = now
    if (now - this.logsAt >= LOGS_MS || !this.logsAt) this.readLogs(where.logs, now)
    if (now - this.heavyAt >= HEAVY_MS || !this.heavyAt) await this.lookForHeavy(now)
  }

  private hostPorts: number[] = []

  /** Heavy work an agent session started on its own, with its session once per process; told to it when that is due. */
  private async lookForHeavy(now: number): Promise<void> {
    this.heavyAt = now
    await this.findProvider(now)
    let found: Outside[]
    let lines: ReturnType<typeof parseProcLines>
    try {
      lines = parseProcLines(await this.deps.run('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,args='], 5_000))
      found = heavyOutside(lines, this.deps.pid, this.provider?.marks ?? [])
    } catch {
      this.outside = []
      return
    }
    const live = new Set(found.map((one) => one.pid))
    for (const pid of [...this.sessions.keys()]) if (!live.has(pid)) this.sessions.delete(pid)
    for (const one of found.slice(0, 8)) {
      if (!this.sessions.has(one.pid)) {
        let session: string | null = null
        try {
          session = sessionFrom(await this.deps.run('ps', ['-E', '-ww', '-o', 'command=', '-p', String(one.pid)], 3_000))
        } catch {
          /* Gone, or its environment cannot be read: said by its session's pid instead. */
        }
        this.sessions.set(one.pid, session)
      }
      one.session = this.sessions.get(one.pid) ?? null
    }
    this.outside = found
    this.told.forget(live, now)
    if (!this.tell || !this.provider) return
    /* The command lines of the flagged processes only, for their own sessions' notices; dropped after. */
    const commands = new Map(lines.filter((line) => live.has(line.pid)).map((line) => [line.pid, line.args]))
    for (const due of this.told.due(found, this.provider, commands, now)) {
      this.told.mark(due, now)
      await (this.deps.ask ?? asksNothing)('messages.notifySession', { session: due.session, body: due.body, kind: 'report' }).catch(() => null)
    }
  }

  /** Who provides the provider of heavy work in turn here, asked of the host every `PROVIDER_MS`. None when the host does not say. */
  private async findProvider(now: number): Promise<void> {
    if (this.providerAt && now - this.providerAt < PROVIDER_MS) return
    this.providerAt = now
    try {
      const found = await (this.deps.ask ?? asksNothing)('services.find', { service: WORK_QUEUE })
      const providers = found.ok ? (found.data as { providers?: unknown } | undefined)?.providers : null
      this.provider = Array.isArray(providers) ? (providerOf(WORK_QUEUE, providers)?.descriptor ?? null) : null
    } catch {
      this.provider = null
    }
  }

  /** Who answers on a module's port; for Kehikot, on any of its ports. */
  private portPid(id: string, port: number): number | undefined {
    if (id === TRAFFIC_HOST_BY) for (const one of this.hostPorts) if (this.listeners.has(one)) return this.listeners.get(one)
    return this.listeners.get(port)
  }

  private readLogs(dir: string, now: number): void {
    this.logsAt = now
    for (const id of this.modules.keys()) {
      if (id === TRAFFIC_HOST_BY) continue
      const file = join(dir, 'modules', `${id.replace(/[^A-Za-z0-9._@-]/g, '_')}.log`)
      let stat: { size: number; mtimeMs: number }
      try {
        stat = statSync(file)
      } catch {
        this.logs.delete(id)
        continue
      }
      const held = this.logs.get(id)
      if (held && held.size === stat.size && held.mtime === stat.mtimeMs) continue
      try {
        /* The host bounds each log to 512 KiB; only the markers and crash lines are looked at. */
        this.logs.set(id, { size: stat.size, mtime: stat.mtimeMs, crashes: crashesIn(readFileSync(file, 'utf8'), stat.mtimeMs) })
      } catch {
        this.logs.delete(id)
      }
    }
  }

  /** What is held, as one snapshot. */
  private said(): Snapshot {
    const now = this.deps.now()
    const day = (times: readonly number[] | undefined) => times?.filter((at) => at >= now - DAY_MS) ?? []
    const modules: ModuleHealth[] = [...this.modules].map(([id, port]) => {
      const points = this.rings.get(id) ?? []
      return {
        id,
        port,
        running: this.trees.has(id),
        procs: this.trees.get(id) ?? 0,
        now: points.at(-1) ?? null,
        points,
        crashedAt: day(this.logs.get(id)?.crashes),
      }
    })
    return { at: this.lastSample, cores: this.deps.cores, memory: this.deps.memory, every: EVERY_MS / 1000, modules, self: this.selfPoint, why: this.why, outside: this.outside, provider: this.provider?.name ?? null }
  }
}

/** The one sampler of this server. */
export const SAMPLER = new Sampler()
