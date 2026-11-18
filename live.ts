import { events, publish, watching, type Stream } from 'kehikot-module-protocol/serve'

import { EVERY_MS } from './health/sampler.ts'
import { NET_EVERY_MS } from './health/network.ts'
import { healthEvent, netEvent, type Event } from './src/health/live.ts'
import type { NetSnapshot } from './src/health/network.ts'
import type { Snapshot } from './src/health/model.ts'

/**
 * Telling the page, instead of the page asking: one held stream per view (`events`, protocol 2.32.0),
 * opened only while the page is on screen and not paused (`subscribe` closes it when it is hidden).
 * The page used to read `/api/network` every 2 s and `/api/health` every 5 s, each answer the whole
 * history again. Now:
 *
 * - **Only while somebody follows.** One pump per topic, started by the first stream that opens and
 *   stopped when the last closes; each tick asks the samplers, which is also what keeps them sampling
 *   (their `snapshot` is "somebody looked"). No stream, no pump, no sampling after `WATCH_MS`.
 * - **Only what is new.** A stream opens with the whole snapshot; each tick publishes the snapshot with
 *   its histories cut to the points the page lacks (`src/health/live.ts`), and nothing at all when
 *   nothing moved (the unchanged case a validator would have answered 304 to).
 * - Health has two topics, for the person's "Tell agents" (the server acts on it: it is what tells them).
 *
 * `/api/health` and `/api/network` stay as they were, for the `health` tool, tests and older pages.
 */

export const HEALTH_EVENTS = '/api/health/events'
export const NETWORK_EVENTS = '/api/network/events'

export interface Sources {
  health: (tell: boolean) => Promise<Snapshot>
  network: () => Promise<NetSnapshot>
}

interface Pump<S> {
  every: number
  read: () => Promise<S>
  say: (last: S | null, now: S) => Event<S> | null
  /** What was last published: what every page that followed from then holds, or newer. */
  last: S | null
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
}

const pumps = new Map<string, Pump<never>>()

/** How many pumps run (tests). */
export const pumping = (): number => [...pumps.values()].filter((one) => one.timer !== null || one.running).length

function stop(topic: string): void {
  const one = pumps.get(topic)
  if (one?.timer) clearTimeout(one.timer)
  pumps.delete(topic)
}

/** Stop every pump (tests, and a server that stops). */
export function stopPumps(): void {
  for (const topic of [...pumps.keys()]) stop(topic)
}

function pump<S>(topic: string, make: () => Pick<Pump<S>, 'every' | 'read' | 'say'>): Pump<S> {
  let one = pumps.get(topic) as Pump<S> | undefined
  if (!one) {
    one = { ...make(), last: null, timer: null, running: false }
    pumps.set(topic, one as unknown as Pump<never>)
  }
  return one
}

function schedule<S>(topic: string, one: Pump<S>): void {
  if (one.timer || one.running) return
  one.timer = setTimeout(async () => {
    one.timer = null
    /* The last stream closed in the meantime: nothing is watching, so nothing is read. */
    if (watching(topic) === 0) return stop(topic)
    one.running = true
    try {
      const now = await one.read()
      const said = one.say(one.last, now)
      /* A copy: what is new is cut against what was published, and a source that changes the
         snapshot it handed out (an array pushed into) must not change that too. */
      one.last = structuredClone(now)
      if (said) publish(topic, said)
    } catch {
      /* A sample that failed is a sample missed: the next tick looks again. */
    } finally {
      one.running = false
    }
    if (watching(topic) === 0) return stop(topic)
    schedule(topic, one)
  }, one.every)
  one.timer.unref?.()
}

/**
 * The doors' `stream`. `initial` is the whole snapshot, read as the stream opens (which is also the
 * first look that starts the samplers); the pump then keeps it moving.
 */
export function makeStream(sources: () => Sources, every: { health: number; network: number } = { health: EVERY_MS, network: NET_EVERY_MS }): Stream {
  return events((path, query) => {
    if (path === HEALTH_EVENTS) {
      const tell = query.get('tell') !== '0'
      const topic = tell ? 'health:tell' : 'health:quiet'
      const one = pump<Snapshot>(topic, () => ({ every: every.health, read: () => sources().health(tell), say: healthEvent }))
      return {
        topic,
        initial: async () => {
          const snapshot = await one.read()
          /* No pump has said anything yet: nobody else holds a snapshot, so this is where the next one is cut from. */
          if (one.last === null) one.last = structuredClone(snapshot)
          queueMicrotask(() => schedule(topic, one))
          return { more: false, snapshot } satisfies Event<Snapshot>
        },
      }
    }
    if (path === NETWORK_EVENTS) {
      const one = pump<NetSnapshot>('network', () => ({ every: every.network, read: () => sources().network(), say: netEvent }))
      return {
        topic: 'network',
        initial: async () => {
          const snapshot = await one.read()
          if (one.last === null) one.last = structuredClone(snapshot)
          queueMicrotask(() => schedule('network', one))
          return { more: false, snapshot } satisfies Event<NetSnapshot>
        },
      }
    }
    return null
  })
}
