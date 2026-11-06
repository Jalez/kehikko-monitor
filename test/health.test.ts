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
  crashesIn,
  crashesSaid,
  goneSaid,
  detailOf,
  healthSaid,
  judge,
  judged,
  mostWithin,
  parseListeners,
  parsePs,
  totals,
  totalsOver,
  treeOf,
} from '../src/health/model.ts'
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

describe('crashes from the host’s start markers', () => {
  const mark = (iso: string) => `${RUN_MARK}${iso} ---`
  test('a crash before a start is a crash; a failed build, a stop and an ordinary start are not', () => {
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
    expect(crashesIn(log)).toEqual([Date.parse('2026-11-01T12:00:00.000Z')])
  })

  test('a crash after the last start is dated when the log was last written', () => {
    expect(crashesIn([mark('2026-11-01T10:00:00.000Z'), 'Segmentation fault'].join('\n'), 123)).toEqual([123])
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
  const build = (min: number, lines: string[] = ['vite v6 building for production...', '✓ built in 1.4s'], ok = true) => [
    `${BUILD_MARK}${iso(min)} (/x) ---`,
    ...lines,
    `--- the build ${ok ? 'finished' : 'did not finish'} after 2.1s ---`,
  ]
  const at = (min: number) => T0 + min * 60_000
  const claudeLog = [start(0), ...build(30), start(31), start(120), start(125), start(128), ...build(200, ['error: script "build" exited with code 1'], false), start(202)].join('\n')
  const diffLog = [
    start(400), 'diff: listening', 'error: script "dev" exited with code 1',
    start(403), 'diff: listening', 'Bun has crashed. This indicates a bug in Bun, not your code.',
    start(406), 'diff: listening', 'error: script "dev" exited with code 1',
    start(409), 'diff: listening',
  ].join('\n')
  const healthOf = (id: string, log: string, now: number) => module(now, { id, crashedAt: crashesIn(log) })

  test('updates and app restarts are not crashes, and what a build prints is never one', () => {
    expect(crashesIn(claudeLog)).toEqual([])
    const now = at(210)
    expect(judge(healthOf('kehikot.claude', claudeLog, now), now).level).toBe('normal')
    expect(crashesSaid({ ...snapshotOf(now), modules: [healthOf('kehikot.claude', claudeLog, now)] }, now)).toBe('')
  })

  test('three crashes in ten minutes are worth a look, said in words', () => {
    const now = at(410)
    expect(crashesIn(diffLog)).toEqual([403, 406, 409].map(at))
    expect(judge(healthOf('kehikot.diff', diffLog, now), now)).toMatchObject({ level: 'critical', said: 'crashed 3 times in 10 min' })
    /* One crash is still a crash; an hour later it is not news. */
    const once = [start(400), 'error: script "dev" exited with code 1', start(401)].join('\n')
    expect(judge(healthOf('kehikot.diff', once, at(420)), at(420)).said).toBe('crashed in the last hour')
    expect(judge(healthOf('kehikot.diff', once, at(470)), at(470)).level).toBe('normal')
  })

  test('the crash line names the module and says nothing else; nothing when none crashed lately', () => {
    const now = at(410)
    const snapshot = { ...snapshotOf(now), modules: [healthOf('kehikot.diff', diffLog, now), healthOf('kehikot.review', start(0), now)] }
    expect(crashesSaid(snapshot, now)).toBe('Diff crashed 3 times in 10 min')
    expect(crashesSaid(snapshot, at(600))).toBe('')
    expect(crashesSaid({ ...snapshot, modules: [{ ...snapshot.modules[0]!, running: false }] }, now)).toBe('Diff is down after a crash')
  })

  test('the most in any window', () => {
    expect(mostWithin([0, 5, 9, 11, 30], 10)).toBe(3)
    expect(mostWithin([0, 5, 9, 11, 30], 10, 6)).toBe(2)
    expect(mostWithin([], 10)).toBe(0)
  })
})

describe('judging', () => {
  test('a crash is worse than busy, busy is worse than quiet; a quiet module says what it costs', () => {
    const ranked = judged(snapshotOf(NOW), NOW)
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
    for (const view of ['now', 'processes', 'disk'] as const) expect(healthSaid(snapshotOf(NOW), NOW, view).length).toBeGreaterThan(20)
    expect(healthSaid({ ...snapshotOf(NOW), at: 0 }, NOW)).toContain('Ask again')
  })

  test('Health says nothing of calls or restarts any more, and the old views say so', () => {
    for (const view of ['now', 'processes', 'disk'] as const) expect(healthSaid(snapshotOf(NOW), NOW, view).toLowerCase()).not.toMatch(/restart|p95|calls? (take|fail)|starts/)
    expect(goneSaid('calls')).toContain('no longer tracks call times')
    expect(goneSaid('restarts')).toContain('no longer tracks restarts')
    expect(healthSaid(snapshotOf(NOW), NOW)).toContain('Diff crashed in the last hour.')
  })
})

describe('the footer’s health', () => {
  const base = { paused: false, rows: [], repeating: 0, budgets: [], gap: false, problem: null }
  test('the worst module, CPU as a meter of the cores and memory; a nearly full disk too', () => {
    const snapshot = snapshotOf(NOW)
    snapshot.disk.free = 20e9
    const items = footerItems({ ...base, health: { snapshot, judged: judged(snapshot, NOW) } })
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
    const items = footerItems({ ...base, health: { snapshot, judged: judged(snapshot, NOW) } })
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

  test('CPU is the time used between two samples, each module counted once; disk and Monitor itself', async () => {
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
      expect(kanban).toMatchObject({ running: true, crashedAt: [] })
      expect(snap.modules.find((m) => m.id === 'kehikot.diff')).toMatchObject({ running: false, points: [] })
      expect(snap.self).toMatchObject({ rss: 40960 * 1024 })
      const disk = (await sampler.snapshot()).disk
      expect(disk.free).toBe(100000 * 1024)
      expect(disk.uses.find((use) => use.kind === 'worktrees')).toMatchObject({ count: 2, withModules: 1, bytes: 1024 * 1024 })
      expect(disk.uses.some((use) => use.label === 'Kehikot’s database')).toBe(true)
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
