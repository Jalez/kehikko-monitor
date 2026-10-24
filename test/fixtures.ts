import type { TrafficCall } from 'kehikot-module-protocol'

/** A row of the host's record, with only what a test cares about said. */
let seq = 0
export function call(more: Partial<TrafficCall> = {}): TrafficCall {
  seq++
  return {
    seq,
    at: 0,
    ms: 3,
    reason: null,
    kind: 'GET',
    host: '127.0.0.1:4180',
    path: '/host/call',
    status: 200,
    ok: true,
    by: 'kehikot.kanban',
    via: 'page',
    side: 'in',
    reported: 'host',
    ...more,
  }
}

/** Kanban asking the host every two seconds for a minute, the same answer each time. */
export function polling(now: number, every = 2000, count = 30, more: Partial<TrafficCall> = {}): TrafficCall[] {
  return Array.from({ length: count }, (_, i) => call({ at: now - (count - i) * every, reason: 'tracker.get', bytesOut: 512, ...more }))
}
