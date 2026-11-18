import { useEffect, useState } from 'react'
import { subscribe } from 'kehikot-module-protocol/client'

import { emptySnapshot, type Snapshot } from '../health/model.ts'
import { applyHealth, isEvent, type Event } from '../health/live.ts'

/**
 * The processes' health, pushed by Monitor's own server over one event stream (`/api/health/events`,
 * `live.ts`) while the page is on screen and not paused: the whole snapshot as it opens, then only the
 * new points. The page asks nothing on a clock. The server samples only while a stream is open, so a
 * closed, hidden or paused page stops the sampling too. (It read `/api/health` every 5 s, the whole
 * history each time.)
 */

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface Health {
  snapshot: Snapshot
  /** A sentence when the server would not answer. */
  problem: string | null
}

/** One plain read (`GET /api/health`), kept for the `health` tool's twin and the tests. Pure but for `fetch`. */
export async function readHealth(fetcher: Fetch, url: string): Promise<Snapshot> {
  const reply = await fetcher(url)
  if (!reply.ok) throw new Error(`Monitor’s server answered ${reply.status}.`)
  const body = (await reply.json()) as Partial<Snapshot> | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.modules) || typeof body.at !== 'number') throw new Error('Monitor’s server answered with something this page cannot read. Reload it.')
  return { ...emptySnapshot(), ...body } as Snapshot
}

/** Why the page has no health: the stream is down. */
export const DETACHED = 'Monitor’s server stopped answering. Health will come back when it does.'

/** The stream's address with the person's "Tell agents" on it: `tell=0` when it is off. */
/** Absolute, never relative: a host frames the page at whatever path it likes (`/app`, `/app/`, with a query), and a relative address then lands off the stream. `test/contract.test.tsx` holds it. */
export const EVENTS = '/api/health/events'

/** What `subscribe` is: one function for every render, so the effect is not started again on each. */
export type Follow = typeof subscribe

export function useHealth(on: boolean, paused: boolean, follow: Follow = subscribe, url: string = EVENTS, tell = true): Health {
  const [health, setHealth] = useState<Health>({ snapshot: emptySnapshot(), problem: null })
  useEffect(() => {
    if (!on || paused) return
    return follow<Event<Snapshot>>(
      url,
      (event) => {
        if (!isEvent(event, 'modules')) return setHealth((was) => ({ ...was, problem: 'Monitor’s server answered with something this page cannot read. Reload it.' }))
        setHealth((was) => ({ snapshot: applyHealth(was.snapshot, event as Event<Snapshot>), problem: null }))
      },
      {
        query: tell ? undefined : { tell: '0' },
        probe: true,
        onAttachment: (attachment) => {
          if (attachment === 'detached') setHealth((was) => ({ ...was, problem: DETACHED }))
        },
      },
    )
  }, [on, paused, follow, url, tell])
  return health
}
