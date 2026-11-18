import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { eventFrame } from 'kehikot-module-protocol/serve'

import { HEALTH_EVENTS, NETWORK_EVENTS, makeStream, stopPumps, type Sources } from '../live.ts'
import { HealthView } from '../src/view/health.tsx'
import { judged, type Snapshot } from '../src/health/model.ts'
import { emptyNet, type NetSnapshot } from '../src/health/network.ts'
import { useHealth } from '../src/wire/use-health.ts'
import { useNetwork } from '../src/wire/use-network.ts'
import { snapshotOf } from './health-fixtures.ts'

/**
 * The contract between Monitor's server and its page: the REAL stream (`makeStream`, as `doors.ts` mounts it),
 * served over real HTTP as server-sent events, into the REAL page client (`subscribe` in the hooks) and the
 * REAL Health view. Only the samplers (what is measured) are fake. If the server and the page ever drift
 * apart — an event's shape, an address, a delta merged wrongly — the charts get no points and this fails.
 */

const NOW = Date.now()
const SEC = (n: number) => n * 1000

/** A page's EventSource, over Bun's own fetch: the browser's wire, with the page's own address to resolve against. */
function eventSourceAt(pageUrl: string) {
  const opened: { close: () => void }[] = []
  class Source {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 2
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((message: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    private abort = new AbortController()
    constructor(address: string) {
      const url = new URL(address, pageUrl)
      opened.push(this)
      void this.run(url)
    }
    addEventListener() {}
    close() {
      this.readyState = 2
      this.abort.abort()
    }
    private async run(url: URL) {
      try {
        const reply = await fetch(url, { signal: this.abort.signal, headers: { accept: 'text/event-stream' } })
        if (!reply.ok || !reply.body) throw new Error(String(reply.status))
        this.readyState = 1
        this.onopen?.()
        let text = ''
        const reader = reply.body.pipeThrough(new TextDecoderStream()).getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          text += value
          for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
            const block = text.slice(0, end)
            text = text.slice(end + 2)
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (data) this.onmessage?.({ data })
          }
        }
      } catch {
        if (this.readyState !== 2) this.onerror?.()
      }
    }
  }
  return { Source: Source as unknown as typeof EventSource, opened }
}

/** Bun serving what `doors()` would: the stream door's emit as `text/event-stream`. */
function serve(sources: Sources, every = 25) {
  const stream = makeStream(() => sources, { health: every, network: every })
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      let close = () => {}
      const body = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          const opened = stream('GET', url.pathname, url.searchParams, (data, name) => controller.enqueue(encoder.encode(eventFrame(data, name))), null)
          if (!opened) return controller.error(new Error('not a stream'))
          if (!('close' in opened)) return controller.error(new Error('refused'))
          controller.enqueue(encoder.encode(': open\n\n'))
          close = opened.close
        },
        cancel: () => close(),
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return server
}

const grow = (s: Snapshot, steps = 1): Snapshot => ({
  ...s,
  at: s.at + steps * SEC(5),
  modules: s.modules.map((m) => {
    if (!m.running) return m
    const points = [...m.points, ...Array.from({ length: steps }, (_, i) => ({ at: s.at + (i + 1) * SEC(5), cpu: 0.4, rss: 2e8 }))]
    return { ...m, points, now: points.at(-1) ?? null }
  }),
})

const net = (at: number, count: number): NetSnapshot => ({
  ...emptyNet(), at, down: 1000, up: 10, interfaces: ['en0'], every: 2,
  points: Array.from({ length: count }, (_, i) => ({ at: at - (count - 1 - i) * SEC(2), down: 1000 + i, up: 10 })),
})

function Page() {
  const health = useHealth(true, false)
  const network = useNetwork(true, false)
  return <HealthView snapshot={health.snapshot} judged={judged(health.snapshot, NOW)} problem={health.problem} now={NOW} net={network.net} netProblem={network.problem} box={{ width: 600, height: 700 }} />
}

const original = globalThis.EventSource
afterEach(() => {
  cleanup()
  stopPumps()
  globalThis.EventSource = original
})

/** How many points a chart holds: the keyboard walks it from its last point to its first. */
const pointsIn = (testId: string): number => {
  const plot = screen.getByTestId(`${testId}-plot`).firstElementChild as HTMLElement
  return plot.tabIndex === 0 ? 1 : 0
}

describe.each([['/app'], ['/app/'], ['/app/?kehikot=1']])('the real server into the real page, framed at %s', (entry) => {
  test('CPU, Memory and Network charts receive points from the first event, and from each one after', async () => {
    let health = snapshotOf(NOW)
    let network = net(NOW, 20)
    const server = serve({ health: async () => health, network: async () => network })
    const { Source } = eventSourceAt(`http://127.0.0.1:${server.port}${entry}`)
    globalThis.EventSource = Source
    render(<Page />)
    try {
      await waitFor(() => expect(screen.getByTestId('tile-cpu-value').textContent).toBe('134%'), { timeout: 2000 })
      expect(pointsIn('tile-cpu')).toBe(1)
      expect(pointsIn('tile-memory')).toBe(1)
      await waitFor(() => expect(screen.getByTestId('tile-network-plot').firstElementChild?.getAttribute('tabindex')).toBe('0'), { timeout: 2000 })
      /* A new sample arrives as a delta: the charts follow it, and the number moves. */
      health = grow(health, 1)
      await waitFor(() => expect(screen.getByTestId('tile-cpu-value').textContent).not.toBe('134%'), { timeout: 2000 })
      expect(pointsIn('tile-cpu')).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})

function Counts() {
  const health = useHealth(true, false)
  const network = useNetwork(true, false)
  const kanban = health.snapshot.modules.find((m) => m.id === 'kehikot.kanban')
  return <p data-testid="counts">{`${kanban?.points.length ?? 0}:${network.net.points.length}:${health.problem ?? ''}${network.problem ?? ''}`}</p>
}

const counts = () => screen.getByTestId('counts').textContent

describe('what the page holds as the stream goes on', () => {
  test('nothing changed: the charts keep their points, nothing blanks, and no problem is said', async () => {
    const health = snapshotOf(NOW)
    const network = net(NOW, 20)
    const server = serve({ health: async () => health, network: async () => network }, 20)
    globalThis.EventSource = eventSourceAt(`http://127.0.0.1:${server.port}/app/`).Source
    render(<Counts />)
    try {
      await waitFor(() => expect(counts()).toBe('6:20:'), { timeout: 2000 })
      await new Promise((resolve) => setTimeout(resolve, 200)) /* ten ticks, none with news */
      expect(counts()).toBe('6:20:')
    } finally {
      server.stop(true)
    }
  })

  test('deltas add points once; a reconnect (the snapshot again) replaces the history rather than doubling it', async () => {
    let health = snapshotOf(NOW)
    let network = net(NOW, 20)
    const server = serve({ health: async () => health, network: async () => network }, 20)
    globalThis.EventSource = eventSourceAt(`http://127.0.0.1:${server.port}/app/`).Source
    render(<Counts />)
    const visibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
    }
    try {
      await waitFor(() => expect(counts()).toBe('6:20:'), { timeout: 2000 })
      health = grow(health, 2)
      network = net(network.at + SEC(4), 22)
      await waitFor(() => expect(counts()).toBe('8:22:'), { timeout: 2000 })
      /* Hidden, then shown: the streams open again and are sent the whole. The pump has moved on meanwhile. */
      visibility('hidden')
      health = grow(health, 1)
      visibility('visible')
      await waitFor(() => expect(counts()).toBe('9:22:'), { timeout: 2000 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(counts()).toBe('9:22:')
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      server.stop(true)
    }
  })

  test('the addresses the page follows are the server\'s, and absolute', async () => {
    const { EVENTS } = await import('../src/wire/use-health.ts')
    const { NET_EVENTS } = await import('../src/wire/use-network.ts')
    expect([EVENTS, NET_EVENTS]).toEqual([HEALTH_EVENTS, NETWORK_EVENTS])
  })
})
