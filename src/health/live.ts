import { HISTORY_MS, type NetSnapshot } from './network.ts'
import { RING, type Snapshot } from './model.ts'

/**
 * What Monitor's server pushes to its page, instead of the page asking every few seconds (health: 5 s,
 * network: 2 s). A page opens ONE event stream per view while it is on screen; the server samples
 * only while one is open, and says only what is new:
 *
 * - the first event on a stream is the whole snapshot (`more: false`);
 * - each later one carries the snapshot with every history cut to the points the page does not yet
 *   have (`more: true`), and is not sent at all when nothing moved.
 *
 * Applying one is idempotent: a point already held is never added again, so a reconnect, which is sent
 * the whole again, or an event heard twice, leaves the same history. Pure: the pump (`health/live.ts`)
 * and the hooks (`src/wire`) share it, and `test/live.test.ts` holds it.
 */

export interface Event<S> {
  /** False: `snapshot` is the whole of it. True: its histories hold only what is newer than the page's. */
  more: boolean
  snapshot: S
}

interface Timed {
  at: number
}

const newerThan = <P extends Timed>(points: readonly P[], at: number): P[] => points.filter((one) => one.at > at)
const lastAt = (points: readonly Timed[] | undefined): number => points?.at(-1)?.at ?? -Infinity

/** A signature of everything but the histories (and how far each reaches): equal means nothing moved. */
const signature = (snapshot: object, strip: (snapshot: never) => object): string => JSON.stringify(strip(snapshot as never))

const healthStrip = (s: Snapshot) => ({ ...s, modules: s.modules.map((one) => ({ ...one, points: lastAt(one.points) })) })
const netStrip = (s: NetSnapshot) => ({ ...s, points: lastAt(s.points) })

/** The event for a page that holds `prev` (what was last pushed) once the server holds `next`; null when nothing is new. */
export function healthEvent(prev: Snapshot | null, next: Snapshot): Event<Snapshot> | null {
  if (!prev) return { more: false, snapshot: next }
  if (signature(prev, healthStrip as never) === signature(next, healthStrip as never)) return null
  const before = new Map(prev.modules.map((one) => [one.id, one]))
  return { more: true, snapshot: { ...next, modules: next.modules.map((one) => ({ ...one, points: newerThan(one.points, lastAt(before.get(one.id)?.points)) })) } }
}

export function netEvent(prev: NetSnapshot | null, next: NetSnapshot): Event<NetSnapshot> | null {
  if (!prev) return { more: false, snapshot: next }
  if (signature(prev, netStrip as never) === signature(next, netStrip as never)) return null
  return { more: true, snapshot: { ...next, points: newerThan(next.points, lastAt(prev.points)) } }
}

/** What the page holds after `event`. A module the server no longer lists is gone; each ring keeps its last `RING`. */
export function applyHealth(held: Snapshot, event: Event<Snapshot>): Snapshot {
  if (!event.more) return event.snapshot
  const before = new Map(held.modules.map((one) => [one.id, one]))
  return {
    ...event.snapshot,
    modules: event.snapshot.modules.map((one) => {
      const had = before.get(one.id)?.points ?? []
      const points = [...had, ...newerThan(one.points, lastAt(had))].slice(-RING)
      return { ...one, points }
    }),
  }
}

/** The same for the network: the history keeps `HISTORY_MS` back from its newest point. */
export function applyNet(held: NetSnapshot, event: Event<NetSnapshot>): NetSnapshot {
  if (!event.more) return event.snapshot
  const all = [...held.points, ...newerThan(event.snapshot.points, lastAt(held.points))]
  const newest = lastAt(all)
  return { ...event.snapshot, points: all.filter((one) => one.at > newest - HISTORY_MS) }
}

/** Whether `value` reads as an event of snapshots: what a page checks before it believes one. */
export function isEvent(value: unknown, listed: 'modules' | 'points'): value is Event<Snapshot & NetSnapshot> {
  if (!value || typeof value !== 'object') return false
  const { more, snapshot } = value as { more?: unknown; snapshot?: unknown }
  if (typeof more !== 'boolean' || !snapshot || typeof snapshot !== 'object') return false
  const s = snapshot as { at?: unknown } & Record<string, unknown>
  return typeof s.at === 'number' && Array.isArray(s[listed])
}
