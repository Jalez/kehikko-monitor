import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { footerItemsSchema } from 'kehikot-module-protocol'

import { EVERY_MS, Sampler, hostPorts, parseDf, parseDu, registered, worktreeRoots, type Deps } from '../health/sampler.ts'
import { footerItems } from '../src/footer.ts'
import {
  BUILD_MARK,
  RUN_MARK,
  cpuSeconds,
  detailOf,
  healthSaid,
  judge,
  judged,
  latencies,
  mostWithin,
  parseListeners,
  parsePs,
  percentile,
  startsIn,
  totals,
  totalsOver,
  treeOf,
  unexplained,
  type ModuleHealth,
  type Starts,
} from '../src/health/model.ts'
import { call } from './fixtures.ts'
import { module, snapshotOf } from './health-fixtures.ts'

const NOW = 2_000_000_000_000

describe('reading ps and lsof', () => {
  test('ps’s CPU time in every shape it is printed', () => {
    expect(cpuSeconds('0:01.50')).toBe(1.5)
    expect(cpuSeconds('90:33.05')).toBeCloseTo(5433.05)
    expect(cpuSeconds('1:02:03')).toBe(3723)
    expect(cpuSeconds('2-01:00:00')).toBe(2 * 86_400 + 3600)
    expect(cpuSeconds('soon')).toBeNaN()
  })

  test('a ps line is a pid, its parent, its memory in KiB and its CPU time; others are skipped', () => {
    expect(parsePs('  100     1  2048   0:10.00\nnonsense\n  101   100   1024   1:00.00\n')).toEqual([
      { pid: 100, ppid: 1, rss: 2048 * 1024, cpu: 10 },
      { pid: 101, ppid: 100, rss: 1024 * 1024, cpu: 60 },
    ])
  })

  test('lsof’s fields say who listens on which port', () => {
    const map = parseListeners('p961\nf12\nn*:57342\np1295\nf9\nn127.0.0.1:4170\nf10\nn[::1]:4170\n')
    expect(map.get(57342)).toBe(961)
    expect(map.get(4170)).toBe(1295)
  })

  test('a module’s tree is its server and what it started, without another module’s tree', () => {
    const procs = parsePs(['10 1 1 0:00', '11 10 1 0:00', '12 11 1 0:00', '20 10 1 0:00', '21 20 1 0:00', '30 1 1 0:00'].join('\n'))
    expect(treeOf(10, procs).sort()).toEqual([10, 11, 12, 20, 21])
    /* Kehikot (10) started a module (20): the module's processes are its own, not Kehikot's. */
    expect(treeOf(10, procs, new Set([20])).sort()).toEqual([10, 11, 12])
    expect(treeOf(20, procs, new Set([20])).sort()).toEqual([20, 21])
  })
})

describe('restarts from the host’s start markers', () => {
  const mark = (iso: string) => `${RUN_MARK}${iso} ---`
  test('every start is counted; a crash before a start is a crash; a failed build and a stop are not', () => {
    const log = [
      mark('2026-11-01T10:00:00.000Z'),
      'VITE ready',
      'error: "vite" exited with code 143',
      mark('2026-11-01T11:00:00.000Z'),
      'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
      mark('2026-11-01T12:00:00.000Z'),
      'error: script "build" exited with code 1',
      mark('2026-11-01T13:00:00.000Z'),
      'a module line that says anything at all',
    ].join('\n')
    const said = startsIn(log)
    expect(said.starts).toEqual(['10', '11', '12', '13'].map((h) => Date.parse(`2026-11-01T${h}:00:00.000Z`)))
    expect(said.crashes).toEqual([Date.parse('2026-11-01T12:00:00.000Z')])
  })

  test('a crash after the last start is dated when the log was last written', () => {
    const said = startsIn([mark('2026-11-01T10:00:00.000Z'), 'Segmentation fault'].join('\n'), 123)
    expect(said.crashes).toEqual([123])
  })
})

/*
 * Module logs as the host writes them (`openRun` in moduleLog.ts, `runBuild` in moduleBuilds.ts):
 * a day with many updates and app restarts, and one with a module that keeps crashing.
 */
describe('worth a look: crashes, not updates or restarts', () => {
  const T0 = Date.parse('2026-11-04T09:00:00.000Z')
  const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()
  const start = (min: number) => `${RUN_MARK}${iso(min)} ---`
  const build = (min: number, lines: string[] = ['vite v6 building for production...', '✓ built in 1.4s', 'built 65e3813 into /x/dist'], ok = true) => [
    `${BUILD_MARK}${iso(min)} (/x) ---`,
    ...lines,
    `--- the build ${ok ? 'finished' : 'did not finish'} after 2.1s ---`,
  ]
  const served = ['kehikot.claude serves its built page on http://127.0.0.1:9030/app (65e3813)']
  const at = (min: number) => T0 + min * 60_000

  /* Claude: started 9 times today. Updated five times (twice within ten minutes), started with the app four times. */
  const claudeLog = [
    start(0), ...served,
    ...build(30), start(31), ...served,
    ...build(36), start(37), ...served,
    ...build(40), start(41), ...served,
    start(120), ...served,
    start(125), ...served,
    start(128), ...served,
    ...build(200, ['error: script "build" exited with code 1'], false), start(202), ...served,
    ...build(300), start(301), ...served,
  ].join('\n')
  /* Two other modules the app started at the same moments as Claude's plain starts. */
  const otherLog = (id: string) => [0, 120, 125, 128].flatMap((min) => [start(min), `${id} serves its built page`]).join('\n')
  /* Diff: a run that exits with code 1, three times in ten minutes. */
  const diffLog = [
    start(400), 'diff: listening', 'error: script "dev" exited with code 1',
    start(403), 'diff: listening', 'Bun has crashed. This indicates a bug in Bun, not your code.',
    start(406), 'diff: listening', 'error: script "dev" exited with code 1',
    start(409), 'diff: listening',
  ].join('\n')

  const healthOf = (id: string, log: Starts, others: Starts[], now: number): ModuleHealth =>
    module(now, { id, starts: log.starts.length, crashes: log.crashes.length, updates: log.updates.length, crashedAt: log.crashes, unexplainedAt: unexplained(log, others), startedAt: log.starts.at(-1) ?? null })

  test('a start after a build is an update; what a build prints is never a crash', () => {
    const claude = startsIn(claudeLog)
    expect(claude.starts).toHaveLength(9)
    expect(claude.updates).toEqual([31, 37, 41, 202, 301].map(at))
    expect(claude.crashes).toEqual([])
  })

  test('starts alongside other modules’ starts are Kehikot’s; lone ones without a reason are left', () => {
    const others = [startsIn(otherLog('kehikot.paper')), startsIn(otherLog('kehikot.flows'))]
    expect(unexplained(startsIn(claudeLog), others)).toEqual([])
    /* Alone, the app's three starts within ten minutes are unexplained. */
    expect(unexplained(startsIn(claudeLog), [])).toEqual([0, 120, 125, 128].map(at))
    expect(unexplained(startsIn(claudeLog), others.slice(0, 1))).toEqual([0, 120, 125, 128].map(at))
  })

  test('nine starts from updates and app restarts are not worth a look', () => {
    const now = at(130)
    const others = [startsIn(otherLog('kehikot.paper')), startsIn(otherLog('kehikot.flows'))]
    const claude = judge(healthOf('kehikot.claude', startsIn(claudeLog), others, now), undefined, now)
    expect(claude.level).toBe('normal')
    expect(claude.said).not.toContain('started')
  })

  test('three crashes in ten minutes are worth a look, said in words', () => {
    const now = at(410)
    const diff = startsIn(diffLog)
    expect(diff.crashes).toEqual([403, 406, 409].map(at))
    expect(judge(healthOf('kehikot.diff', diff, [], now), undefined, now)).toMatchObject({ level: 'critical', said: 'crashed 3 times in 10 min' })
    /* One crash is still a crash; an hour later it is not news. */
    const once = startsIn([start(400), 'error: script "dev" exited with code 1', start(401)].join('\n'))
    expect(judge(healthOf('kehikot.diff', once, [], at(420)), undefined, at(420)).said).toBe('crashed in the last hour')
    expect(judge(healthOf('kehikot.diff', once, [], at(470)), undefined, at(470)).level).toBe('normal')
  })

  test('three starts in ten minutes that nothing explains are worth a word, without a crash’s weight', () => {
    const now = at(130)
    const lone = startsIn([0, 120, 125, 128].map(start).join('\n'))
    expect(judge(healthOf('kehikot.notes', lone, [], now), undefined, now)).toMatchObject({ level: 'warn', said: 'started 3 times in 10 min, no update or crash in its log' })
    /* Two are not a burst. */
    const two = startsIn([0, 120, 125].map(start).join('\n'))
    expect(judge(healthOf('kehikot.notes', two, [], now), undefined, now).level).toBe('normal')
  })

  test('the most in any window', () => {
    expect(mostWithin([0, 5, 9, 11, 30], 10)).toBe(3)
    expect(mostWithin([0, 5, 9, 11, 30], 10, 6)).toBe(2)
    expect(mostWithin([], 10)).toBe(0)
  })
})

describe('latency and errors from the traffic record', () => {
  test('nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(sorted, 0.5)).toBe(50)
    expect(percentile(sorted, 0.95)).toBe(95)
    expect(percentile([], 0.5)).toBeNull()
  })

  test('per caller: the calls it made, and the calls its server answered on its port', () => {
    const calls = [
      ...Array.from({ length: 19 }, (_, i) => call({ at: NOW - 1000 - i, by: 'kehikot.kanban', ms: 10 })),
      call({ at: NOW - 900, by: 'kehikot.kanban', ms: 3000, ok: false, status: 500 }),
      call({ at: NOW - 800, by: 'kehikko', side: 'out', host: '127.0.0.1:4190', ms: 40 }),
      call({ at: NOW - 10 * 60_000, by: 'kehikot.kanban', ms: 99_999 }),
      call({ at: NOW - 700, by: 'kehikot.kanban', side: 'seen', ms: 99_999 }),
    ]
    const lat = latencies(calls, NOW, new Map([['kehikot.diff', 4190]]))
    const kanban = lat.find((one) => one.by === 'kehikot.kanban')!
    expect(kanban).toMatchObject({ calls: 20, errors: 1, p50: 10, p95: 10 })
    const diff = lat.find((one) => one.by === 'kehikot.diff')!
    expect(diff.calls).toBe(0)
    expect(diff.answered).toMatchObject({ calls: 1, p95: 40 })
  })
})

describe('judging', () => {
  test('a crash is worse than busy, busy is worse than quiet; a quiet module says what it costs', () => {
    const ranked = judged(snapshotOf(NOW), [], NOW)
    expect(ranked.map((one) => [one.name, one.level])).toEqual([
      ['Diff', 'critical'],
      ['Kanban', 'warn'],
      ['Kehikot', 'normal'],
      ['Review', 'normal'],
      ['Notes', 'normal'],
    ])
    expect(ranked[1]!.said).toBe('120% CPU')
    expect(ranked.at(-1)!.said).toBe('not running')
  })

  test('slow calls and failing calls are worth a word', () => {
    const snapshot = snapshotOf(NOW)
    const ranked = judged(snapshot, [{ by: 'kehikot.review', timed: 10, calls: 10, errors: 5, p50: 100, p95: 2500, answered: null }], NOW)
    expect(ranked.find((one) => one.id === 'kehikot.review')).toMatchObject({ level: 'warn', said: 'calls take 2.5 s (p95)' })
  })

  test('totals count every running module once, and the charts add them at each sample', () => {
    const snapshot = snapshotOf(NOW)
    expect(totals(snapshot)).toMatchObject({ running: 4, registered: 4 })
    expect(totals(snapshot).cpu).toBeCloseTo(0.1 + 1.2 + 0.02 + 0.02)
    const over = totalsOver(snapshot)
    expect(over).toHaveLength(6)
    expect(over.at(-1)!.rss).toBe(500e6 + 300e6 + 80e6 + 80e6)
  })

  test('how much the view shows follows its own size', () => {
    expect(detailOf(null)).toBe('full')
    expect(detailOf({ width: 600, height: 200 })).toBe('glance')
    expect(detailOf({ width: 300, height: 600 })).toBe('list')
    expect(detailOf({ width: 600, height: 600 })).toBe('full')
  })

  test('every view of the tool answers, and before a sample it says to ask again', () => {
    for (const view of ['now', 'processes', 'calls', 'restarts', 'disk'] as const) expect(healthSaid(snapshotOf(NOW), [], NOW, view).length).toBeGreaterThan(20)
    expect(healthSaid({ ...snapshotOf(NOW), at: 0 }, [], NOW)).toContain('Ask again')
  })
})

describe('the footer’s health', () => {
  const base = { paused: false, rows: [], repeating: 0, budgets: [], gap: false, problem: null }
  test('the worst module, CPU as a meter of the cores and memory; a nearly full disk too', () => {
    const snapshot = snapshotOf(NOW)
    snapshot.disk.free = 20e9
    const items = footerItems({ ...base, health: { snapshot, judged: judged(snapshot, [], NOW) } })
    expect(footerItemsSchema.safeParse(items).success).toBe(true)
    expect(items.find((i) => i.id === 'worst')).toMatchObject({ kind: 'text', text: 'Diff: crashed in the last hour', level: 'critical' })
    expect(items.find((i) => i.id === 'cpu')).toMatchObject({ kind: 'meter', label: 'CPU', text: '134% · 10 cores' })
    expect(items.find((i) => i.id === 'memory')).toMatchObject({ text: '960 MB memory' })
    expect(items.find((i) => i.id === 'disk')).toMatchObject({ level: 'critical' })
    expect(items.at(-1)).toMatchObject({ id: 'clear' })
  })

  test('with nothing wrong it names the busiest; before the first sample it says nothing of health', () => {
    const snapshot = snapshotOf(NOW)
    snapshot.modules = snapshot.modules.filter((m) => m.id === 'kehikko' || m.id === 'kehikot.review')
    const items = footerItems({ ...base, health: { snapshot, judged: judged(snapshot, [], NOW) } })
    expect(items.find((i) => i.id === 'worst')).toMatchObject({ text: 'Busiest: Kehikot · 10% CPU, 500 MB', level: 'normal' })
    expect(footerItems({ ...base, health: { snapshot: { ...snapshot, at: 0 }, judged: [] } }).some((i) => i.id === 'cpu')).toBe(false)
  })
})

describe('the sampler', () => {
  const home = mkdtempSync(join(tmpdir(), 'monitor-health-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const machine = join(home, 'Library', 'Application Support', 'Kehikot')
  mkdirSync(join(machine, 'modules'), { recursive: true })
  mkdirSync(join(machine, 'installed'), { recursive: true })
  writeFileSync(join(machine, 'modules', 'kehikot.kanban.json'), JSON.stringify({ url: 'http://127.0.0.1:4180', dir: '/x' }))
  writeFileSync(join(machine, 'modules', 'roadmap.diff.json'), JSON.stringify({ url: 'http://127.0.0.1:4190', dir: '/y' }))
  writeFileSync(join(machine, 'frame.sqlite'), 'x'.repeat(2048))
  const logs = join(home, 'Library', 'Logs', 'Kehikot', 'modules')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'kehikot.kanban.log'), `${RUN_MARK}${new Date(NOW - 60_000).toISOString()} ---\nready\n`)
  const trees = join(home, 'Projects', 'app', '.claude', 'worktrees')
  mkdirSync(join(trees, 'one', 'node_modules'), { recursive: true })
  mkdirSync(join(trees, 'two'), { recursive: true })

  let clock = NOW
  let cpu = 0
  const ran: string[] = []
  const deps: Deps = {
    now: () => clock,
    env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:4170' },
    home,
    cores: 8,
    memory: 16e9,
    pid: 900,
    run: async (file, args) => {
      ran.push(file === 'nice' ? `nice ${args[2]}` : file)
      if (file === 'ps') return [`1 0 1000 0:00`, `500 1 204800 0:${cpu.toFixed(2)}`, `501 500 102400 0:${cpu.toFixed(2)}`, `600 500 51200 0:${(cpu * 2).toFixed(2)}`, `900 1 40960 0:00.10`].join('\n')
      if (file === 'lsof') return 'p500\nn127.0.0.1:4170\np600\nn127.0.0.1:4180\n'
      if (file === 'df') return 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk3 1000000 900000 100000 90% /'
      if (file === 'nice') return `${args.slice(4).map((path) => `1024\t${path}`).join('\n')}\n`
      throw new Error(`not expected: ${file}`)
    },
  }

  test('registry, host ports, du and df are read as they are printed', () => {
    /* `roadmap.diff.json` registers kehikot.diff: the old spelling is the same module. */
    expect(new Map(registered(join(machine, 'modules')))).toEqual(new Map([['kehikot.kanban', 4180], ['kehikot.diff', 4190]]))
    expect(hostPorts({ KEHIKOT_ORIGINS: 'http://127.0.0.1:4170,http://localhost:4171' })).toEqual([4170, 4171])
    expect(parseDu('8\t/a\n16\t/b c\n').get('/b c')).toBe(16 * 1024)
    expect(parseDf('h\n/dev/x 100 50 40 50% /')).toEqual({ total: 102400, free: 40960 })
    expect(worktreeRoots(home)).toEqual([trees])
  })

  test('CPU is the time used between two samples, each module counted once; restarts, disk and Monitor itself', async () => {
    const sampler = new Sampler(deps)
    try {
      await sampler.snapshot()
      clock += EVERY_MS
      cpu = 1
      const snap = await sampler.snapshot()
      await sampler.settled()
      const kanban = snap.modules.find((m) => m.id === 'kehikot.kanban')!
      const host = snap.modules.find((m) => m.id === 'kehikko')!
      /* Kanban's server (600) used 2 s in 5 s; Kehikot (500, 501) used 1 s each, without Kanban's. */
      expect(kanban.now!.cpu).toBeCloseTo(0.4)
      expect(host.now!.cpu).toBeCloseTo(0.4)
      expect(host.procs).toBe(2)
      expect(host.now!.rss).toBe((204800 + 102400) * 1024)
      expect(kanban).toMatchObject({ running: true, starts: 1, crashes: 0 })
      expect(snap.modules.find((m) => m.id === 'kehikot.diff')).toMatchObject({ running: false, points: [] })
      expect(snap.self).toMatchObject({ rss: 40960 * 1024 })
      const disk = (await sampler.snapshot()).disk
      expect(disk.free).toBe(100000 * 1024)
      expect(disk.uses.find((use) => use.kind === 'worktrees')).toMatchObject({ count: 2, withModules: 1, bytes: 1024 * 1024 })
      expect(disk.uses.some((use) => use.label.includes('frame.sqlite'))).toBe(true)
      /* lsof is not asked again before LISTEN_MS while every server is still there. */
      expect(ran.filter((one) => one === 'lsof')).toHaveLength(1)
    } finally {
      sampler.stop()
    }
  })

  test('nothing is sampled when nobody asks', async () => {
    const before = ran.length
    const sampler = new Sampler(deps)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ran.length).toBe(before)
    sampler.stop()
  })
})
