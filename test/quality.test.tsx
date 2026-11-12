import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { CLOCK, NETWORK, SPEED, TICKET, answer } from '../doors.ts'
import { probe, QualitySampler, within, type QualityDeps } from '../health/quality.ts'
import { WATCH_MS } from '../health/sampler.ts'
import { SpeedTest } from '../health/speed.ts'
import { footerItems } from '../src/footer.ts'
import { judged } from '../src/health/model.ts'
import { emptyNet, networkSaid, type NetSnapshot } from '../src/health/network.ts'
import {
  badSinceAfter,
  BAD_FOR_MS,
  bitsSaid,
  connectionSaid,
  emptyQuality,
  hostOf,
  hostsFrom,
  idleSpeed,
  jitterOf,
  judge,
  keptRounds,
  parseHosts,
  PUBLIC_HOST,
  QUALITY_HISTORY_MS,
  qualityOf,
  SPEED_SAID,
  speedOf,
  targetsOf,
  THRESHOLDS,
  verdictSaid,
  withLatency,
  type Probe,
  type Quality,
  type Round,
  type SpeedState,
} from '../src/health/quality.ts'
import { connectionItems } from '../src/inbox.ts'
import { resetTips } from '../src/lib/one-tip.ts'
import { HealthView } from '../src/view/health.tsx'
import { SPARK_HEIGHT } from '../src/view/tiles.ts'
import { pressSpeed } from '../src/wire/use-network.ts'
import { snapshotOf } from './health-fixtures.ts'

afterEach(cleanup)

const NOW = 2_000_000_000

const answered = (host: string, ms: number, dns: number | null = 5): Probe => ({ host, ms, dns, why: '' })
const lost = (host: string, why = 'no answer in 2 s'): Probe => ({ host, ms: null, dns: null, why })

/** Rounds every 10 s up to `now`, each host's round trips in order (null: lost). */
function roundsOf(hosts: Record<string, readonly (number | null)[]>, now = NOW, dns: number | null = 5): Round[] {
  const count = Math.max(...Object.values(hosts).map((one) => one.length))
  return Array.from({ length: count }, (_, i) => ({
    at: now - (count - 1 - i) * 10_000,
    probes: Object.entries(hosts).map(([host, all]) => {
      const ms = all[i] ?? null
      return ms === null ? lost(host) : answered(host, ms, host === PUBLIC_HOST ? null : dns)
    }),
  }))
}

const steady = (ms: number, count = 6) => Array.from({ length: count }, () => ms)

describe('the verdict and its thresholds', () => {
  test('nothing yet is Measuring', () => {
    expect(judge([])).toMatchObject({ level: 'measuring', word: 'Measuring' })
  })

  test('Good: every host under 80 ms, nothing lost, steady, quick lookups', () => {
    const verdict = judge(roundsOf({ 'github.com': steady(24), [PUBLIC_HOST]: steady(12) }))
    expect(verdict).toMatchObject({ level: 'good', word: 'Good', lost: 0, sent: 12, jitter: 0 })
    expect(verdict.ms).toBe(18)
    expect(verdict.reason).toBe('all 2 hosts answer quickly, nothing lost')
    expect(verdictSaid(verdict)).toBe('Good · 18 ms · 0% loss')
    expect(verdictSaid(verdict, true)).toBe('Good · 18 ms')
  })

  test('the round trip: Fair from 80 ms, Poor from 200 ms, said by host', () => {
    expect(THRESHOLDS).toMatchObject({ goodMs: 80, fairMs: 200, fairLoss: 0.05 })
    expect(judge(roundsOf({ 'github.com': steady(79) }))).toMatchObject({ level: 'good' })
    expect(judge(roundsOf({ 'github.com': steady(80) }))).toMatchObject({ level: 'fair', reason: 'latency to github.com: 80 ms' })
    expect(judge(roundsOf({ 'github.com': steady(30), 'gitlab.example.com': steady(420) }))).toMatchObject({ level: 'poor', reason: 'high latency to gitlab.example.com: 420 ms' })
  })

  test('probes lost: any is Fair, 5% or more is Poor, and whose when one host lost them all', () => {
    const lostOne = roundsOf({ a: steady(20, 6), b: steady(20, 6), c: steady(20, 6), d: [...steady(20, 5), null] }) // 1 of 24, 4%
    expect(judge(lostOne)).toMatchObject({ level: 'fair', lost: 1, sent: 24, reason: '1 of 24 probes lost (all to d)' })
    const lostTwo = roundsOf({ 'github.com': [20, null, 20, 20, 20, 20], [PUBLIC_HOST]: [10, 10, null, 10, 10, 10] }) // 2 of 12
    expect(judge(lostTwo)).toMatchObject({ level: 'poor', reason: '2 of 12 probes lost' })
  })

  test('jitter and slow lookups count too', () => {
    expect(jitterOf([10, 50, 10, 50])).toBe(40)
    expect(judge(roundsOf({ 'github.com': [10, 50, 10, 50, 10, 50] }))).toMatchObject({ level: 'fair', reason: 'unsteady latency to github.com: jitter 40 ms' })
    expect(judge(roundsOf({ 'github.com': [10, 150, 10, 150, 10, 150] }))).toMatchObject({ level: 'poor' })
    expect(judge(roundsOf({ 'github.com': steady(20) }, NOW, 600))).toMatchObject({ level: 'poor', reason: 'slow name lookup for github.com: 600 ms' })
  })

  test('the worst figure decides; only the last minute is judged', () => {
    const old = roundsOf({ 'github.com': steady(900, 6) }, NOW - 60_000)
    const fresh = roundsOf({ 'github.com': steady(20, 6) })
    expect(judge([...old, ...fresh])).toMatchObject({ level: 'good' })
  })
})

describe('offline', () => {
  test('the newest round got no answer from anyone: Offline, and the footer says so', () => {
    const rounds = [...roundsOf({ 'github.com': steady(20, 5), [PUBLIC_HOST]: steady(10, 5) }, NOW - 10_000), { at: NOW, probes: [lost('github.com', 'the name did not resolve'), lost(PUBLIC_HOST)] }]
    const verdict = judge(rounds)
    expect(verdict).toMatchObject({ level: 'offline', word: 'Offline', reason: 'no answer from any of 2 hosts' })
    expect(verdictSaid(verdict)).toBe('Offline')
    expect(connectionSaid(verdict)).toBe('Offline')
  })

  test('names that do not resolve while the public address answers is Poor, not Offline', () => {
    const rounds = roundsOf({ [PUBLIC_HOST]: steady(10) }).map((round) => ({ ...round, probes: [...round.probes, lost('github.com', 'the name did not resolve')] }))
    expect(judge(rounds)).toMatchObject({ level: 'poor', reason: '6 of 12 probes lost (all to github.com)' })
  })

  test('Poor or Offline is timed from when it turned, and forgotten when it recovers', () => {
    expect(badSinceAfter(null, 'poor', 5)).toBe(5)
    expect(badSinceAfter(5, 'offline', 9)).toBe(5)
    expect(badSinceAfter(5, 'fair', 9)).toBeNull()
    expect(badSinceAfter(null, 'good', 9)).toBeNull()
  })
})

describe('which hosts are probed', () => {
  test('a host from a URL, a host:port or a name; local and junk are none', () => {
    expect(hostOf('https://GitLab.Example.com/group/repo/-/boards')).toBe('gitlab.example.com')
    expect(hostOf('api.github.com:443')).toBe('api.github.com')
    expect(hostOf('not a host')).toBe('')
    expect(parseHosts('gitlab.example.com, https://git.acme.io/x  localhost 127.0.0.1 ;rm')).toEqual(['gitlab.example.com', 'git.acme.io'])
    expect(parseHosts(undefined)).toEqual([])
  })

  test('from Kehikot’s record: the calls it made out, not this computer, the most called first', () => {
    const calls = [
      { host: '127.0.0.1:4180', side: 'out' as const },
      { host: 'gitlab.example.com', side: 'out' as const },
      { host: 'api.github.com', side: 'out' as const },
      { host: 'gitlab.example.com:443', side: 'out' as const },
      { host: 'evil.example.com', side: 'in' as const },
      { host: '192.168.1.4:80', side: 'out' as const },
    ]
    expect(hostsFrom(calls)).toEqual(['gitlab.example.com', 'api.github.com'])
  })

  test('configured first, then what Kehikot calls, then github.com, at most four; the public address last', () => {
    expect(targetsOf([], [])).toEqual(['github.com', PUBLIC_HOST])
    expect(targetsOf(['git.acme.io'], ['gitlab.example.com', 'github.com'])).toEqual(['git.acme.io', 'gitlab.example.com', 'github.com', PUBLIC_HOST])
    expect(targetsOf(['a.io', 'b.io', 'c.io', 'd.io'], ['e.io'])).toEqual(['a.io', 'b.io', 'c.io', 'd.io', PUBLIC_HOST])
  })

  test('ten minutes of rounds are kept', () => {
    const rounds = keptRounds(roundsOf({ x: steady(10, 70) }, NOW - 10_000), { at: NOW, probes: [] })
    expect(rounds.every((one) => one.at > NOW - QUALITY_HISTORY_MS)).toBe(true)
    expect(rounds).toHaveLength(60)
  })
})

describe('a probe', () => {
  function clocked(steps: { lookup?: number; connect?: number; lookupFails?: boolean; connectFails?: boolean; hang?: 'lookup' | 'connect' }) {
    let t = 1000
    const looked: string[] = []
    const opened: string[] = []
    const deps = {
      tick: () => t,
      timeoutMs: 30,
      lookup: async (host: string) => {
        looked.push(host)
        if (steps.hang === 'lookup') return new Promise<string>(() => {})
        if (steps.lookupFails) throw new Error('ENOTFOUND')
        t += steps.lookup ?? 0
        return '140.82.121.4'
      },
      connect: async (address: string) => {
        opened.push(address)
        if (steps.hang === 'connect') return new Promise<void>(() => {})
        if (steps.connectFails) throw new Error('ECONNREFUSED')
        t += steps.connect ?? 0
      },
    }
    return { deps, looked, opened }
  }

  test('the name lookup and the round trip, timed apart; an address is not looked up', async () => {
    const { deps, opened } = clocked({ lookup: 12, connect: 24 })
    expect(await probe('github.com', deps)).toEqual({ host: 'github.com', ms: 24, dns: 12, why: '' })
    expect(opened).toEqual(['140.82.121.4'])
    const plain = clocked({ connect: 9 })
    expect(await probe(PUBLIC_HOST, plain.deps)).toEqual({ host: PUBLIC_HOST, ms: 9, dns: null, why: '' })
    expect(plain.looked).toEqual([])
  })

  test('a name that does not resolve, a refused connection, and no answer in time are lost, each said', async () => {
    expect(await probe('github.com', clocked({ lookupFails: true }).deps)).toMatchObject({ ms: null, why: 'the name did not resolve' })
    expect(await probe('github.com', clocked({ connectFails: true }).deps)).toMatchObject({ ms: null, dns: 0, why: 'the connection was refused' })
    expect(await probe('github.com', clocked({ hang: 'lookup' }).deps)).toMatchObject({ ms: null, why: 'the name did not resolve in 0.03 s' })
    expect(await probe(PUBLIC_HOST, clocked({ hang: 'connect' }).deps)).toMatchObject({ ms: null, why: 'no answer in 0.03 s' })
  })

  test('within: the work, or a timeout', async () => {
    expect(await within(Promise.resolve(3), 20)).toBe(3)
    await expect(within(new Promise(() => {}), 10)).rejects.toThrow('timeout')
  })
})

describe('probes only run while Monitor is watched', () => {
  function deps(over: Partial<QualityDeps> = {}) {
    let clock = NOW
    const sent: string[] = []
    const d: QualityDeps = {
      lookup: async () => '10.9.9.9',
      connect: async (address) => {
        sent.push(address)
      },
      tick: () => 0,
      now: () => clock,
      called: async () => ['gitlab.example.com'],
      configured: undefined,
      timeoutMs: 50,
      everyMs: 10_000,
      ...over,
    }
    return { d, sent, advance: (ms: number) => (clock += ms) }
  }

  test('nothing is sent when nobody asks', async () => {
    const { d, sent } = deps()
    const sampler = new QualitySampler(d, new SpeedTest())
    await new Promise((done) => setTimeout(done, 20))
    expect(sent).toEqual([])
    sampler.stop()
  })

  test('an ask sends a round to every target; asked again within the interval, nothing more', async () => {
    const { d, sent, advance } = deps()
    const sampler = new QualitySampler(d, new SpeedTest())
    try {
      const first = await sampler.snapshot(true)
      expect(first.targets).toEqual(['gitlab.example.com', 'github.com', PUBLIC_HOST])
      expect(first.verdict.level).toBe('good')
      expect(sent).toHaveLength(3)
      await sampler.snapshot()
      expect(sent).toHaveLength(3)
      advance(10_000)
      await sampler.snapshot(true)
      await new Promise((done) => setTimeout(done, 5))
      expect(sent).toHaveLength(6)
    } finally {
      sampler.stop()
    }
  })

  test('rounds go on while watched and stop once nobody has asked for WATCH_MS', async () => {
    const { d, sent, advance } = deps({ everyMs: 5 })
    const sampler = new QualitySampler(d, new SpeedTest())
    try {
      await sampler.snapshot(true)
      await new Promise((done) => setTimeout(done, 40))
      const whileWatched = sent.length
      expect(whileWatched).toBeGreaterThan(3)
      advance(WATCH_MS + 1)
      await new Promise((done) => setTimeout(done, 20))
      const after = sent.length
      await new Promise((done) => setTimeout(done, 30))
      expect(sent.length).toBe(after)
    } finally {
      sampler.stop()
    }
  })

  test('the page does not wait for the first round; the tool does', async () => {
    const { d } = deps({ connect: () => new Promise((done) => setTimeout(done, 15)) })
    const sampler = new QualitySampler(d, new SpeedTest())
    try {
      expect((await sampler.snapshot()).at).toBe(0)
      expect((await sampler.snapshot(true)).at).toBe(NOW)
    } finally {
      sampler.stop()
    }
  })
})

describe('the speed test', () => {
  test('the figure: every counted transfer’s bytes over their time, the warm-up left out', () => {
    expect(speedOf([])).toBeNull()
    expect(speedOf([{ bytes: 1e6, ms: 1000 }])).toBe(1e6)
    expect(speedOf([{ bytes: 1e6, ms: 5000 }, { bytes: 4e6, ms: 1000 }, { bytes: 10e6, ms: 2000 }])).toBe(14e6 / 3)
    expect(bitsSaid(14e6 / 3)).toBe('37 Mbit/s')
    expect(bitsSaid(117.5e6)).toBe('940 Mbit/s')
    expect(bitsSaid(500_000)).toBe('4 Mbit/s')
    expect(bitsSaid(100_000)).toBe('800 kbit/s')
    expect(bitsSaid(null)).toBe('—')
    expect(SPEED_SAID).toBe('Downloads about 25 MB and uploads about 10 MB from Cloudflare.')
  })

  function fakeServer(down: (size: number) => Response | Promise<Response>, up: () => Response = () => new Response('ok')) {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        seen.push(`${request.method} ${url.pathname}${url.search}`)
        if (url.pathname === '/__down') return down(Number(url.searchParams.get('bytes')))
        if (url.pathname === '/__up') {
          await request.arrayBuffer()
          return up()
        }
        return new Response('no', { status: 404 })
      },
    })
    return { server, seen, base: `http://127.0.0.1:${server.port}` }
  }

  function speedTest(base: string, phaseMs = 2000) {
    let t = 0
    return new SpeedTest({
      fetch: (url, init) => fetch(url, init),
      base,
      /* Each read of the clock is 10 ms on: the figure is the fake server's bytes over a known time. */
      tick: () => (t += 10),
      now: () => NOW,
      plan: { down: [1000, 4000, 6000], up: [1000, 3000] },
      phaseMs,
    })
  }

  test('against a fake server: downloads then uploads as planned, and says the result with when', async () => {
    const { server, seen, base } = fakeServer((size) => new Response(new Uint8Array(size)))
    try {
      const test = speedTest(base)
      await test.start()
      const state = test.state()
      expect(seen).toEqual(['GET /__down?bytes=1000', 'GET /__down?bytes=4000', 'GET /__down?bytes=6000', 'POST /__up', 'POST /__up'])
      expect(state).toMatchObject({ state: 'done', phase: null, why: '' })
      expect(state.last).toMatchObject({ at: NOW, downBytes: 11000, upBytes: 4000 })
      expect(state.last?.down).toBeGreaterThan(0)
      expect(state.last?.up).toBe(3000 / 0.01)
    } finally {
      server.stop(true)
    }
  })

  test('cancel stops it where it is and keeps the last result', async () => {
    let release: () => void = () => {}
    const { server, base } = fakeServer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(100))
              release = () => controller.close()
            },
          }),
        ),
    )
    try {
      const test = speedTest(base, 10_000)
      const running = test.start()
      expect(test.state()).toMatchObject({ state: 'testing', phase: 'download' })
      await new Promise((done) => setTimeout(done, 30))
      test.cancel()
      await running
      release()
      expect(test.state()).toMatchObject({ state: 'cancelled', phase: null, last: null })
    } finally {
      server.stop(true)
    }
  })

  test('a phase cut short counts what it moved, and goes on to the next', async () => {
    const holds: (() => void)[] = []
    const { server, seen, base } = fakeServer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(500))
              holds.push(() => controller.close())
            },
          }),
        ),
    )
    try {
      const test = speedTest(base, 40)
      await test.start()
      for (const release of holds) {
        try {
          release()
        } catch {
          /* Already closed when the fetch was aborted. */
        }
      }
      expect(seen.filter((one) => one.startsWith('GET'))).toEqual(['GET /__down?bytes=1000'])
      expect(test.state()).toMatchObject({ state: 'done', last: { downBytes: 500, upBytes: 4000 } })
    } finally {
      server.stop(true)
    }
  })

  test('a server that refuses is said', async () => {
    const refusing = fakeServer(() => new Response('busy', { status: 503 }))
    try {
      const test = speedTest(refusing.base)
      await test.start()
      expect(test.state()).toMatchObject({ state: 'failed', why: 'the test server answered 503.' })
    } finally {
      refusing.server.stop(true)
    }
  })
})

/* ---- the page, the footer, the tool ---- */

function qualityAt(level: 'good' | 'poor' | 'offline', speed: SpeedState = idleSpeed()): Quality {
  const rounds =
    level === 'good'
      ? roundsOf({ 'github.com': steady(24), 'gitlab.example.com': steady(30), [PUBLIC_HOST]: steady(12) })
      : level === 'poor'
        ? roundsOf({ 'github.com': steady(30), 'gitlab.example.com': steady(420), [PUBLIC_HOST]: steady(12) })
        : [{ at: NOW, probes: [lost('github.com'), lost(PUBLIC_HOST)] }]
  return qualityOf(rounds, ['github.com', 'gitlab.example.com', PUBLIC_HOST], level === 'good' ? null : NOW - 90_000, speed)
}

function netWith(quality: Quality, count = 30): NetSnapshot {
  const points = Array.from({ length: count }, (_, i) => ({ at: NOW - (count - 1 - i) * 2000, down: 2_400_000, up: 120_000 }))
  return { ...emptyNet(), at: NOW, down: 2_400_000, up: 120_000, points, interfaces: ['en0'], quality }
}

describe('the Network tile’s connection', () => {
  const snapshot = snapshotOf(NOW)
  const done: SpeedState = { state: 'done', phase: null, last: { at: NOW - 60_000, down: 85e6 / 8, up: 20e6 / 8, downBytes: 25e6, upBytes: 10e6 }, why: '' }

  test('the latency joins the throughput’s points: the round at or just before each, null when lost', () => {
    const joined = withLatency(
      [{ at: 100, down: 1, up: 1 }, { at: 9_000, down: 1, up: 1 }, { at: 12_000, down: 1, up: 1 }, { at: 60_000, down: 1, up: 1 }],
      [{ at: 1_000, ms: 20 }, { at: 11_000, ms: null }],
    )
    expect(joined.map((one) => one.ms)).toEqual([undefined, 20, null, undefined])
  })

  test('large: the verdict as a word with the round trip and loss in the head, each host, the speed test with what it spends', () => {
    const pressed: string[] = []
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={netWith(qualityAt('good', done))} box={{ width: 700, height: 800 }} onSpeed={(action) => pressed.push(action)} />)
    expect(screen.getByTestId('tile-network-value').textContent).toBe('Good · 24 ms · 0% loss')
    expect(screen.getByTestId('tile-network-verdict').getAttribute('data-level')).toBe('good')
    expect(screen.getByTestId('tile-network-rates').textContent).toContain('↓ 2.4 MB/s · ↑ 120 kB/s')
    expect(screen.getByTestId('tile-network-quality').textContent).toContain('Connection good: all 3 hosts answer quickly, nothing lost')
    expect([...screen.getByTestId('tile-network-hosts').querySelectorAll('li')].map((one) => one.textContent)).toEqual([
      'github.com: 24 ms · 0% loss · jitter 0 ms · lookup 5 ms',
      'gitlab.example.com: 30 ms · 0% loss · jitter 0 ms · lookup 5 ms',
      '1.1.1.1 (public): 12 ms · 0% loss · jitter 0 ms',
    ])
    const speed = screen.getByTestId('tile-network-speed')
    expect(speed.textContent).toContain('↓ 85 Mbit/s · ↑ 20 Mbit/s · measured')
    expect(speed.textContent).toContain(SPEED_SAID)
    fireEvent.click(screen.getByRole('button', { name: 'Test speed' }))
    expect(pressed).toEqual(['start'])
    expect(screen.getAllByRole('img').some((one) => one.getAttribute('aria-label')?.includes('The connection is good · 24 ms · 0% loss'))).toBe(true)
  })

  test('a running test can be cancelled; a failed one says why', () => {
    const pressed: string[] = []
    const { unmount } = render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={netWith(qualityAt('good', { ...idleSpeed(), state: 'testing', phase: 'upload' }))} box={{ width: 700, height: 800 }} onSpeed={(action) => pressed.push(action)} />)
    expect(screen.getByTestId('tile-network-speed').textContent).toContain('Testing upload…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(pressed).toEqual(['cancel'])
    unmount()
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={netWith(qualityAt('good', { ...idleSpeed(), state: 'failed', why: 'the test server answered 503.' }))} box={{ width: 700, height: 800 }} />)
    expect(screen.getByTestId('tile-network-speed').textContent).toContain('The speed test failed: the test server answered 503.')
  })

  test('small: the verdict word and round trip in the head, the sparkline, nothing else', () => {
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={netWith(qualityAt('poor'))} box={{ width: 220, height: 200 }} />)
    expect(screen.getByTestId('tile-network-value').textContent).toBe('Poor · 30 ms')
    expect(screen.getByTestId('tile-network-verdict').getAttribute('data-level')).toBe('poor')
    expect(screen.getByTestId('tile-network-plot').style.height).toBe(`${SPARK_HEIGHT}px`)
    expect(screen.queryByTestId('tile-network-quality')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Test speed' })).toBeNull()
  })

  test('offline is the word alone, never a colour alone', () => {
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={netWith(qualityAt('offline'))} box={{ width: 220, height: 200 }} />)
    expect(screen.getByTestId('tile-network-value').textContent).toBe('Offline')
  })

  test('the tooltip says the round trip of that moment, and goes when the pointer leaves', () => {
    render(<HealthView snapshot={snapshot} judged={judged(snapshot, NOW)} problem={null} now={NOW} net={netWith(qualityAt('good'))} box={{ width: 220, height: 200 }} />)
    resetTips()
    const plot = screen.getByTestId('tile-network-plot').firstElementChild as HTMLElement
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(plot, { clientX: 199, clientY: 20, pointerType: 'mouse' })
    expect(screen.getByTestId('tile-network-tip').textContent).toContain('ms round trip')
    fireEvent.pointerLeave(plot, { pointerType: 'mouse' })
    expect(screen.getByTestId('tile-network-tip').textContent).toBe('')
  })
})

describe('the footer and the Inbox', () => {
  const base = { paused: false, rows: [], repeating: 0, budgets: [], gap: false, problem: null }

  test('"Connection good · 24 ms" before the rates, which go first in a narrow row; nothing before the first probes', () => {
    const items = footerItems({ ...base, network: netWith(qualityAt('good')) })
    const connection = items.find((one) => one.id === 'connection')
    expect(connection).toMatchObject({ kind: 'text', text: 'Connection good · 24 ms', level: 'normal' })
    expect(items.findIndex((one) => one.id === 'connection')).toBe(items.findIndex((one) => one.id === 'network') - 1)
    expect(items.find((one) => one.id === 'network')).toMatchObject({ optional: true })
    expect(items.find((one) => one.id === 'connection')).toMatchObject({ optional: false })
    expect(footerItems({ ...base, network: netWith(emptyQuality()) }).some((one) => one.id === 'connection')).toBe(false)
  })

  test('Poor warns, Offline is critical, each in words', () => {
    expect(footerItems({ ...base, network: netWith(qualityAt('poor')) }).find((one) => one.id === 'connection')).toMatchObject({ text: 'Connection poor · 30 ms', level: 'warn' })
    expect(footerItems({ ...base, network: netWith(qualityAt('offline')) }).find((one) => one.id === 'connection')).toMatchObject({ text: 'Offline', level: 'critical' })
  })

  test('an Inbox item only after a minute of Poor or Offline, and none once it recovers', () => {
    const poor = qualityAt('poor')
    expect(connectionItems({ ...poor, badSince: NOW - BAD_FOR_MS + 1 }, NOW)).toEqual([])
    expect(connectionItems({ ...poor, badSince: NOW - BAD_FOR_MS }, NOW)).toEqual([
      expect.objectContaining({ id: 'connection', state: 'working', priority: 'normal', label: 'The internet connection is poor', group: 'Connection' }),
    ])
    expect(connectionItems(qualityAt('offline'), NOW)[0]).toMatchObject({ label: 'This computer is offline' })
    expect(connectionItems(qualityAt('good'), NOW)).toEqual([])
  })
})

describe('the tool and the doors', () => {
  test('health’s network view leads with the verdict, each host, the last speed test', async () => {
    CLOCK.now = () => NOW
    let waited: boolean | undefined
    NETWORK.snapshot = async (wait) => {
      waited = wait
      return netWith(qualityAt('poor', { state: 'done', phase: null, last: { at: NOW - 5 * 60_000, down: 85e6 / 8, up: 20e6 / 8, downBytes: 25e6, upBytes: 10e6 }, why: '' }))
    }
    const reply = await answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health', arguments: { view: 'network' } } }, null)
    const said = (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(waited).toBe(true)
    expect(said.startsWith('Connection quality: Poor — high latency to gitlab.example.com: 420 ms.')).toBe(true)
    expect(said).toContain('Expect long pushes, pulls and downloads to be slow or to fail')
    expect(said).toContain('- gitlab.example.com: 420 ms · 0% loss · jitter 0 ms · lookup 5 ms')
    expect(said).toContain('- 1.1.1.1 (public): 12 ms · 0% loss')
    expect(said).toContain('The last speed test, 5 min ago: download 85 Mbit/s, upload 20 Mbit/s.')
    expect(said).toContain('This computer\'s network now: download 2.4 MB/s')
  })

  test('before any probe and with no speed test, it says so', () => {
    expect(networkSaid(netWith(emptyQuality()), NOW)).toContain('Monitor has not probed the connection yet')
    const said = networkSaid(netWith(qualityAt('offline')), NOW)
    expect(said).toContain('Connection quality: Offline — no answer from any of 2 hosts.')
    expect(said).toContain('No speed test has been run since Monitor started')
  })

  test('/api/speed: POST from the page only (its ticket), start or cancel', async () => {
    const calls: string[] = []
    SPEED.start = () => void calls.push('start')
    SPEED.cancel = () => void calls.push('cancel')
    SPEED.state = () => ({ ...idleSpeed(), state: 'testing', phase: 'download' })
    expect((await answer('GET', '/api/speed', new URLSearchParams(), null, TICKET))?.status).toBe(405)
    expect((await answer('POST', '/api/speed', new URLSearchParams(), { action: 'start' }, null))?.status).toBe(403)
    expect((await answer('POST', '/api/speed', new URLSearchParams(), { action: 'nuke' }, TICKET))?.status).toBe(400)
    const started = await answer('POST', '/api/speed', new URLSearchParams(), { action: 'start' }, TICKET)
    expect(started?.body).toMatchObject({ ok: true, speed: { state: 'testing' } })
    await answer('POST', '/api/speed', new URLSearchParams(), { action: 'cancel' }, TICKET)
    expect(calls).toEqual(['start', 'cancel'])
  })

  test('the page’s press: the state the server answered, or why not', async () => {
    const asked: unknown[] = []
    expect(await pressSpeed('start', async (path, options) => (asked.push([path, options.body]), { ok: true, body: { ok: true, speed: { ...idleSpeed(), state: 'testing' } } }))).toMatchObject({ state: 'testing' })
    expect(asked).toEqual([['/api/speed', { action: 'start' }]])
    expect(await pressSpeed('start', async () => ({ ok: false, body: null, error: 'Stale page.' }))).toBe('Stale page.')
  })
})
