import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { cpus, homedir, totalmem } from 'node:os'
import { join } from 'node:path'

import { TRAFFIC_HOST_BY } from 'kehikot-module-protocol'

import { parseListeners, parsePs, startsIn, treeOf, unexplained, type Disk, type DiskUse, type ModuleHealth, type Point, type Proc, type Snapshot, type Starts } from '../src/health/model.ts'

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
 *   changed: the host's start markers and crash lines (`startsIn`). Nothing else of it is kept.
 * - Sizes, every `DISK_MS`: `df` for the home folder's disk, `stat` for frame.sqlite, `du` at the
 *   lowest priority for the installed modules, versions and logs; agent worktrees are counted
 *   every time and summed every `WORKTREES_MS`. Sizes only:
 *   no file's contents are read.
 *
 * Nothing is written anywhere.
 */

export const EVERY_MS = 5_000
export const WATCH_MS = 30_000
export const RING = 60
export const LISTEN_MS = 15_000
export const REGISTRY_MS = 30_000
export const LOGS_MS = 60_000
export const DISK_MS = 30 * 60_000
/** How often agent worktrees are summed with `du`: rarely, because it reads every file's size in them. */
export const WORKTREES_MS = 6 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

/** Where a person keeps code, under the home folder: agent worktrees are looked for here, three folders deep. */
export const CODE_DIRS = ['Projects', 'projects', 'src', 'code', 'dev', 'Developer', 'repos', 'git', 'work']

export interface Deps {
  run: (file: string, args: string[], timeoutMs: number) => Promise<string>
  now: () => number
  env: Record<string, string | undefined>
  home: string
  cores: number
  memory: number
  pid: number
}

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
  home: homedir(), // kehikot-storage: allow read-only: where Kehikot's machine folder, its logs and agent worktrees are, for their sizes
  cores: cpus().length || 1,
  memory: totalmem(),
  pid: process.pid,
}

/** Kehikot's machine folder, its registry and its logs, as the host spells them (`KEHIKOT_*`, else the defaults). */
export function places(deps: Pick<Deps, 'env' | 'home'>) {
  const machine = join(deps.home, 'Library', 'Application Support', 'Kehikot')
  return {
    machine,
    registry: deps.env.KEHIKOT_MODULES_DIR || join(machine, 'modules'),
    installed: deps.env.KEHIKOT_INSTALLS_DIR || join(machine, 'installed'),
    versions: deps.env.KEHIKOT_VERSIONS_DIR || join(machine, 'versions'),
    frame: deps.env.KEHIKOT_FRAME_DB || join(machine, 'frame.sqlite'),
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

/** Folders of agent worktrees: `*-worktrees`, and `.claude/worktrees` inside a repository, up to three folders under a code folder. */
export function worktreeRoots(home: string, dirs: readonly string[] = CODE_DIRS, depth = 3): string[] {
  const found: string[] = []
  const walk = (dir: string, left: number) => {
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name.endsWith('-worktrees')) found.push(path)
      else if (entry.name === '.claude') {
        if (existsSync(join(path, 'worktrees'))) found.push(join(path, 'worktrees'))
      } else if (left > 1 && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') walk(path, left - 1)
    }
  }
  /* On a disk that ignores case, Projects and projects are one folder: walk each folder once. */
  const walked = new Set<string>()
  for (const dir of dirs) {
    let real: string
    try {
      real = realpathSync.native(join(home, dir))
    } catch {
      continue
    }
    if (walked.has(real)) continue
    walked.add(real)
    walk(join(home, dir), depth)
  }
  return found
}

/** `du -sk` lines: KiB and a path. */
export function parseDu(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0) out.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024)
  }
  return out
}

/** `df -k <path>`'s last line: total and free bytes. */
export function parseDf(text: string): { total: number; free: number } | null {
  const line = text.trim().split('\n').at(-1) ?? ''
  const cols = line.split(/\s+/)
  const total = Number(cols[1]) * 1024
  const free = Number(cols[3]) * 1024
  return Number.isFinite(total) && Number.isFinite(free) && total > 0 ? { total, free } : null
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

const tilde = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

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

  private logs = new Map<string, { size: number; mtime: number; starts: Starts }>()
  private logsAt = 0

  private disk: Disk = { at: null, free: null, total: null, uses: [], why: '' }
  private diskRunning: Promise<void> | null = null

  constructor(deps: Deps = DEPS) {
    this.deps = deps
  }

  /** Somebody looked: keep sampling for a while, take a sample if the last is stale, and say what is held. */
  async snapshot(): Promise<Snapshot> {
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
    if (!this.diskRunning && (this.disk.at === null ? true : now - this.disk.at >= DISK_MS)) this.diskRunning = this.measureDisk().finally(() => (this.diskRunning = null))
  }

  private hostPorts: number[] = []

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
        this.logs.set(id, { size: stat.size, mtime: stat.mtimeMs, starts: startsIn(readFileSync(file, 'utf8'), stat.mtimeMs) })
      } catch {
        this.logs.delete(id)
      }
    }
  }

  private worktreeSizes = new Map<string, { bytes: number; at: number }>()

  /** One folder's size with `du` at the lowest priority, or null when it took too long or could not be read. */
  private async du(path: string, timeoutMs: number): Promise<number | null> {
    try {
      return parseDu(await this.deps.run('nice', ['-n', '19', 'du', '-sk', path], timeoutMs)).get(path) ?? null
    } catch {
      return null
    }
  }

  private async measureDisk(): Promise<void> {
    const { deps } = this
    const where = places(deps)
    const uses: DiskUse[] = []
    const why: string[] = []
    let free: number | null = null
    let total: number | null = null
    try {
      const df = parseDf(await deps.run('df', ['-k', deps.home], 10_000))
      if (df) ({ free, total } = df)
    } catch {
      why.push('the free space of the disk')
    }
    const frame = sizeOf(where.frame) + sizeOf(`${where.frame}-wal`) + sizeOf(`${where.frame}-shm`)
    if (frame) uses.push({ label: 'Kehikot’s database (frame.sqlite)', kind: 'kehikot', bytes: frame })
    for (const one of [
      { path: where.installed, label: 'Installed modules', kind: 'kehikot' as const },
      { path: where.versions, label: 'Kept versions', kind: 'kehikot' as const },
      { path: where.logs, label: 'Logs', kind: 'logs' as const },
    ]) {
      if (!existsSync(one.path)) continue
      const bytes = await this.du(one.path, 60_000)
      if (bytes === null) why.push(`the size of ${one.label.toLowerCase()}`)
      else uses.push({ label: one.label, kind: one.kind, bytes })
    }
    const counted: DiskUse[] = []
    const publish = () => {
      this.disk = {
        at: deps.now(),
        free,
        total,
        uses: [...uses, ...counted].sort((a, b) => b.bytes - a.bytes),
        why: why.length ? `Monitor could not measure ${why.slice(0, 3).join(', ')}${why.length > 3 ? ` and ${why.length - 3} more` : ''} in time.` : '',
      }
    }
    /* Kehikot's own folders are said at once; the worktrees follow as each is measured. */
    publish()
    /*
     * Agent worktrees are counted every time (a folder listing), and measured only every
     * `WORKTREES_MS`: a hundred worktrees with node_modules take minutes of disk reading to sum.
     */
    const now = deps.now()
    for (const root of worktreeRoots(deps.home)) {
      let names: string[] = []
      try {
        names = readdirSync(root).filter((name) => !name.startsWith('.'))
      } catch {
        continue
      }
      if (!names.length) continue
      const withModules = names.filter((name) => existsSync(join(root, name, 'node_modules'))).length
      let held = this.worktreeSizes.get(root)
      if (!held || now - held.at >= WORKTREES_MS) {
        const bytes = await this.du(root, 5 * 60_000)
        if (bytes !== null) this.worktreeSizes.set(root, (held = { bytes, at: now }))
        else why.push(`the size of ${tilde(root, deps.home)}`)
      }
      counted.push({ label: tilde(root, deps.home), kind: 'worktrees', bytes: held?.bytes ?? 0, count: names.length, withModules })
      publish()
    }
    publish()
  }

  /** What is held, as one snapshot. */
  private said(): Snapshot {
    const now = this.deps.now()
    const day = (times: readonly number[] | undefined) => times?.filter((at) => at >= now - DAY_MS) ?? []
    const every = [...this.logs].map(([id, held]) => ({ id, starts: held.starts }))
    const modules: ModuleHealth[] = [...this.modules].map(([id, port]) => {
      const points = this.rings.get(id) ?? []
      const log = this.logs.get(id)?.starts
      const starts = day(log?.starts)
      const crashes = day(log?.crashes)
      return {
        id,
        port,
        running: this.trees.has(id),
        procs: this.trees.get(id) ?? 0,
        now: points.at(-1) ?? null,
        points,
        starts: starts.length,
        crashes: crashes.length,
        updates: day(log?.updates).length,
        startedAt: log?.starts.at(-1) ?? null,
        crashedAt: crashes,
        /* Other modules' starts tell Kehikot's own starts (the app starting, restarting to update) from this module's. */
        unexplainedAt: log ? day(unexplained(log, every.filter((one) => one.id !== id).map((one) => one.starts))) : [],
      }
    })
    return { at: this.lastSample, cores: this.deps.cores, memory: this.deps.memory, every: EVERY_MS / 1000, modules, disk: this.disk, self: this.selfPoint, why: this.why }
  }

  /** Wait for a disk measurement under way: for the tests. */
  async settled(): Promise<void> {
    await this.diskRunning
  }
}

/** The one sampler of this server. */
export const SAMPLER = new Sampler()
