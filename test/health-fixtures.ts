import type { ModuleHealth, Point, Snapshot } from '../src/health/model.ts'

/** A ring of samples ending at `now`, every five seconds, at a steady CPU and memory. */
export function ring(now: number, cpu: number, rss: number, count = 6): Point[] {
  return Array.from({ length: count }, (_, i) => ({ at: now - (count - 1 - i) * 5000, cpu, rss }))
}

export function module(now: number, more: Partial<ModuleHealth> & { id: string }): ModuleHealth {
  const points = more.points ?? ring(now, 0.02, 80e6)
  return { port: null, running: true, procs: 1, now: points.at(-1) ?? null, points, crashedAt: [], ...more }
}

/** Kehikot, a busy Kanban, a Diff that crashed, a quiet Review and a stopped Notes. */
export function snapshotOf(now: number): Snapshot {
  return {
    at: now,
    cores: 10,
    memory: 16e9,
    every: 5,
    modules: [
      module(now, { id: 'kehikko', port: 4170, points: ring(now, 0.1, 500e6), procs: 4 }),
      module(now, { id: 'kehikot.kanban', port: 4180, points: ring(now, 1.2, 300e6) }),
      module(now, { id: 'kehikot.diff', port: 4190, crashedAt: [now - 20 * 60_000] }),
      module(now, { id: 'kehikot.review', port: 4200 }),
      module(now, { id: 'kehikot.notes', port: 4210, running: false, procs: 0, points: [], now: null }),
    ],
    self: { at: now, cpu: 0.004, rss: 50e6 },
    why: '',
  }
}
