import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { watching } from 'kehikot-module-protocol/serve'

import { HEALTH_EVENTS, NETWORK_EVENTS, makeStream, pumping, stopPumps, type Sources } from '../live.ts'
import { RING, type Point, type Snapshot } from '../src/health/model.ts'
import { HISTORY_MS, emptyNet, type NetPoint, type NetSnapshot } from '../src/health/network.ts'
import { applyHealth, applyNet, healthEvent, isEvent, netEvent } from '../src/health/live.ts'
import { useHealth } from '../src/wire/use-health.ts'
import { useNetwork } from '../src/wire/use-network.ts'
import { module, ring, snapshotOf } from './health-fixtures.ts'

const NOW = 2_000_000_000

afterEach(() => {
  stopPumps()
  cleanup()
})

/* ---- what is said, and how a page takes it ---- */

const grown = (s: Snapshot, steps: number): Snapshot => {
  const at = s.at + steps * 5000
  return {
    ...s,
    at,
    modules: s.modules.map((m) => {
      if (!m.running) return m
      const added: Point[] = Array.from({ length: steps }, (_, i) => ({ at: s.at + (i + 1) * 5000, cpu: 0.5, rss: 1e8 }))
      const points = [...m.points, ...added].slice(-RING)
      return { ...m, points, now: points.at(-1) ?? null }
    }),
  }
}

describe('health, said as what is new', () => {
  test('a page that holds nothing is sent the whole; one that holds the last is sent only the new points', () => {
    const first = snapshotOf(NOW)
    expect(healthEvent(null, first)).toEqual({ more: false, snapshot: first })
    const next = grown(first, 1)
    const said = healthEvent(first, next)!
    expect(said.more).toBe(true)
    for (const m of said.snapshot.modules.filter((one) => one.running)) expect(m.points).toHaveLength(1)
    expect(JSON.stringify(said).length).toBeLessThan(JSON.stringify(first).length)
  })

  test('nothing moved: nothing is said', () => {
    const first = snapshotOf(NOW)
    expect(healthEvent(first, structuredClone(first))).toBeNull()
  })

  test('applying a run of events leaves the page with exactly what the server holds, whatever the order of arrival or repeats', () => {
    let server = snapshotOf(NOW)
    let held = applyHealth(snapshotOf(0), healthEvent(null, server)!)
    let last = server
    for (const steps of [1, 1, 2, 1]) {
      server = grown(server, steps)
      const said = healthEvent(last, server)!
      held = applyHealth(held, said)
      held = applyHealth(held, said) /* heard twice */
      last = server
      expect(held).toEqual(server)
    }
  })

  test('a ring never holds more than RING points, and a module the server dropped is gone', () => {
    let server = snapshotOf(NOW)
    let held = server
    let last = server
    server = grown(server, RING + 10)
    held = applyHealth(held, healthEvent(last, server)!)
    expect(held.modules.find((m) => m.id === 'kehikot.kanban')!.points).toHaveLength(RING)
    last = server
    server = { ...server, at: server.at + 5000, modules: server.modules.filter((m) => m.id !== 'kehikot.kanban') }
    held = applyHealth(held, healthEvent(last, server)!)
    expect(held.modules.map((m) => m.id)).not.toContain('kehikot.kanban')
  })

  test('a module that appeared since is sent with its whole ring', () => {
    const first = snapshotOf(NOW)
    const next = { ...grown(first, 1), modules: [...grown(first, 1).modules, module(NOW + 5000, { id: 'kehikot.new', points: ring(NOW + 5000, 0.3, 1e8, 6) })] }
    const said = healthEvent(first, next)!
    expect(said.snapshot.modules.find((m) => m.id === 'kehikot.new')!.points).toHaveLength(6)
  })
})

const netPoint = (at: number): NetPoint => ({ at, down: 1000, up: 10 })
const net = (at: number, count: number, over: Partial<NetSnapshot> = {}): NetSnapshot => ({
  ...emptyNet(), at, down: 1000, up: 10, interfaces: ['en0'], points: Array.from({ length: count }, (_, i) => netPoint(at - (count - 1 - i) * 2000)), ...over,
})

describe('network, said as what is new', () => {
  test('only the new points, none when nothing moved, and the history stays inside its window', () => {
    const first = net(NOW, 150)
    expect(netEvent(first, structuredClone(first))).toBeNull()
    const next = net(NOW + 2000, 150)
    const said = netEvent(first, next)!
    expect(said.snapshot.points).toEqual([netPoint(NOW + 2000)])
    expect(applyNet(first, said)).toEqual(next)
    expect(applyNet(applyNet(first, said), said)).toEqual(next)
    let held = first
    let last = first
    for (let i = 1; i <= 400; i++) {
      const server = net(NOW + i * 2000, 1, { points: [...last.points, netPoint(NOW + i * 2000)] })
      held = applyNet(held, netEvent(last, server)!)
      last = server
    }
    expect(held.points.at(-1)!.at - held.points[0]!.at).toBeLessThan(HISTORY_MS)
  })

  test('a quality change with no new point is still said (a probe, a speed test)', () => {
    const first = net(NOW, 5)
    const next = { ...first, why: 'The connection dropped.' }
    expect(netEvent(first, next)?.snapshot.why).toBe('The connection dropped.')
  })
})

test('a page believes only what reads as an event', () => {
  expect(isEvent({ more: false, snapshot: snapshotOf(NOW) }, 'modules')).toBe(true)
  expect(isEvent({ more: false, snapshot: net(NOW, 1) }, 'points')).toBe(true)
  for (const bad of [null, 'x', {}, { more: 1, snapshot: {} }, { more: true, snapshot: { at: 'x', modules: [] } }, { more: true, snapshot: { at: 1 } }]) expect(isEvent(bad, 'modules')).toBe(false)
})

/* ---- the server: pushed, only while followed, and quiet when idle ---- */

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function server() {
  const reads = { health: 0, network: 0, tell: [] as boolean[] }
  let serverNow = snapshotOf(NOW)
  let netNow = net(NOW, 3)
  const sources: Sources = {
    health: async (tell) => (reads.health++, reads.tell.push(tell), serverNow),
    network: async () => (reads.network++, netNow),
  }
  const stream = makeStream(() => sources, { health: 30, network: 30 })
  const open = (path: string, query = '') => {
    const heard: unknown[] = []
    const opened = stream('GET', path, new URLSearchParams(query), (event) => heard.push(event), null)
    if (!opened || !('close' in opened)) throw new Error(`${path} is not a stream`)
    return { heard, close: opened.close }
  }
  return { reads, open, move: () => ((serverNow = grown(serverNow, 1)), (netNow = net(netNow.at + 2000, 3))) }
}

describe('the server pushes only while a page follows', () => {
  test('a stream opens with the whole, then only what moved; a quiet server sends nothing', async () => {
    const s = server()
    const page = s.open(HEALTH_EVENTS)
    await settle(10)
    expect(page.heard).toHaveLength(1)
    expect((page.heard[0] as { more: boolean }).more).toBe(false)
    await settle(120)
    expect(page.heard).toHaveLength(1) /* four ticks, nothing moved, nothing sent */
    s.move()
    await settle(80)
    expect(page.heard.length).toBeGreaterThan(1)
    expect((page.heard[1] as { more: boolean }).more).toBe(true)
    page.close()
  })

  test('no stream, no pump and no sampling: the last to close stops it', async () => {
    const s = server()
    expect(pumping()).toBe(0)
    const a = s.open(NETWORK_EVENTS)
    const b = s.open(NETWORK_EVENTS)
    await settle(80)
    expect(pumping()).toBe(1)
    expect(watching('network')).toBe(2)
    a.close()
    await settle(80)
    expect(pumping()).toBe(1)
    b.close()
    await settle(100)
    expect(pumping()).toBe(0)
    const reads = s.reads.network
    await settle(120)
    expect(s.reads.network).toBe(reads)
  })

  test('"Tell agents" off is its own topic, read with tell false', async () => {
    const s = server()
    const quiet = s.open(HEALTH_EVENTS, 'tell=0')
    const told = s.open(HEALTH_EVENTS)
    await settle(80)
    expect(s.reads.tell).toContain(false)
    expect(s.reads.tell).toContain(true)
    expect(watching('health:quiet')).toBe(1)
    expect(watching('health:tell')).toBe(1)
    quiet.close()
    told.close()
  })

  test('what the old page cost, and what this does: over a minute of a 5 s and a 2 s read, no request at all', async () => {
    /* The old pages made 12 + 30 requests a minute, each the whole history. A stream is one connection;
       every sample after it is an event on it. Counted here as HTTP asks the page makes: none. */
    const asked: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => (asked.push(String(input)), new Response('{}'))) as typeof fetch
    const s = server()
    const page = s.open(NETWORK_EVENTS)
    for (let i = 0; i < 4; i++) {
      s.move()
      await settle(40)
    }
    page.close()
    globalThis.fetch = realFetch
    expect(asked).toEqual([])
    expect(page.heard.length).toBeGreaterThanOrEqual(2)
  })
})

/* ---- the page: listens only while it is shown ---- */

describe('the page listens only while it is on screen and not paused', () => {
  const follows = () => {
    const opened: { url: string; query: unknown; closed: boolean; emit: (e: unknown) => void }[] = []
    const follow = ((url: string, onEvent: (event: unknown) => void, options?: { query?: unknown }) => {
      const one = { url, query: options?.query, closed: false, emit: onEvent }
      opened.push(one)
      return () => void (one.closed = true)
    }) as never
    return { opened, follow }
  }

  function Probe({ on, paused, follow, tell = true }: { on: boolean; paused: boolean; follow: never; tell?: boolean }) {
    const health = useHealth(on, paused, follow, undefined, tell)
    const network = useNetwork(on, paused, follow)
    return <p data-testid="p">{health.snapshot.modules.length}:{network.net.points.length}</p>
  }

  test('paused or off screen: no stream; shown: one for health and one for the network; paused again: both closed', () => {
    const f = follows()
    const view = render(<Probe on paused follow={f.follow} />)
    expect(f.opened).toEqual([])
    view.rerender(<Probe on paused={false} follow={f.follow} />)
    expect(f.opened.map((o) => o.url)).toEqual(['./api/health/events', './api/network/events'])
    view.rerender(<Probe on paused follow={f.follow} />)
    expect(f.opened.every((o) => o.closed)).toBe(true)
    const count = f.opened.length
    view.rerender(<Probe on={false} paused={false} follow={f.follow} />)
    expect(f.opened).toHaveLength(count)
    view.unmount()
  })

  test('events are taken into what is drawn; "Tell agents" off goes on the stream', () => {
    const f = follows()
    const view = render(<Probe on paused={false} follow={f.follow} tell={false} />)
    expect(f.opened[0]!.query).toEqual({ tell: '0' })
    act(() => f.opened[0]!.emit({ more: false, snapshot: snapshotOf(NOW) }))
    act(() => f.opened[1]!.emit({ more: false, snapshot: net(NOW, 4) }))
    expect(view.getByTestId('p').textContent).toBe('5:4')
    view.unmount()
  })
})
