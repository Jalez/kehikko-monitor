import { useEffect, useRef, useState } from 'react'

import { trafficReadResult, type TrafficBudget, type TrafficCall, type TrafficProcesses } from 'kehikot-module-protocol'

import { HELD, held } from '../traffic/model.ts'

/**
 * The host's record of traffic, read every `EVERY_MS` while the page is open and not paused: the
 * rows after the last one held (`since`), so each read carries only what is new. `sample: true`
 * keeps the host looking at its processes' connections while this page is open, and only then.
 */

export const EVERY_MS = 1000

export type Ask = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export interface Traffic {
  calls: TrafficCall[]
  budgets: TrafficBudget[]
  processes: TrafficProcesses | null
  /** A sentence when the host would not answer, or could not be asked. */
  problem: string | null
  /** Rows the host dropped before this page read them (its ring is bounded). */
  gap: boolean
  /** When the page last heard from the host, ms. */
  at: number | null
}

/** One read: what is held after it, and the cursor to ask from next. Pure, so a test drives it. */
export async function readOnce(
  ask: Ask,
  cursor: { since: number; started: number | null },
  before: readonly TrafficCall[],
  now: number,
): Promise<{ traffic: Omit<Traffic, 'at'>; cursor: { since: number; started: number | null } }> {
  const raw = await ask('traffic.read', { since: cursor.since, limit: HELD, sample: true })
  const read = trafficReadResult.safeParse(raw)
  if (!read.success) throw new Error('Kehikot answered with something Monitor cannot read. It may be a different version.')
  const restarted = cursor.started !== null && read.data.started !== cursor.started
  /* A host that restarted numbers from 1 again: read it from the start, and keep what was held. */
  const fresh = restarted ? read.data.calls : read.data.calls.filter((call) => call.seq > cursor.since)
  return {
    traffic: { calls: held(before, fresh, now), budgets: read.data.budgets, processes: read.data.processes, problem: null, gap: read.data.gap },
    cursor: { since: read.data.newest, started: read.data.started },
  }
}

/** Why the host would not answer, in the person's words. */
export function problemOf(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error)
  if (/unknown-method|not one of them/i.test(said)) return 'This Kehikot keeps no record of traffic yet. Update Kehikot to see it.'
  if (/traffic:read/.test(said)) return 'Kehikot did not let Monitor read its traffic: Monitor’s manifest has to ask for it. Update Monitor.'
  return `Kehikot did not answer: ${said}`
}

export function useTraffic(ask: Ask | null, paused: boolean, clearedAt: number, now: () => number = Date.now): Traffic {
  const [traffic, setTraffic] = useState<Traffic>({ calls: [], budgets: [], processes: null, problem: null, gap: false, at: null })
  const cursor = useRef<{ since: number; started: number | null }>({ since: 0, started: null })
  const calls = useRef<TrafficCall[]>([])

  useEffect(() => {
    calls.current = calls.current.filter((call) => call.at >= clearedAt)
    setTraffic((was) => ({ ...was, calls: calls.current }))
  }, [clearedAt])

  useEffect(() => {
    if (!ask || paused) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const read = await readOnce(ask, cursor.current, calls.current, now())
        if (!live) return
        cursor.current = read.cursor
        calls.current = read.traffic.calls.filter((call) => call.at >= clearedAt)
        setTraffic({ ...read.traffic, calls: calls.current, at: now() })
      } catch (error) {
        if (live) setTraffic((was) => ({ ...was, problem: problemOf(error) }))
      }
      if (live) timer = setTimeout(tick, EVERY_MS)
    }
    void tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [ask, paused, clearedAt, now])

  return traffic
}
