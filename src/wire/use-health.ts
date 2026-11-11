import { useEffect, useState } from 'react'

import { emptySnapshot, type Snapshot } from '../health/model.ts'

/**
 * The processes' health, from Monitor's own server (`GET /api/health`), every `EVERY_MS` while the
 * page is open and not paused. The server samples only while it is asked, so a closed page stops
 * the sampling too.
 */

export const EVERY_MS = 5000

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface Health {
  snapshot: Snapshot
  /** A sentence when the server would not answer. */
  problem: string | null
}

/** One read. Pure but for `fetch`, so a test drives it. */
export async function readHealth(fetcher: Fetch, url: string): Promise<Snapshot> {
  const reply = await fetcher(url)
  if (!reply.ok) throw new Error(`Monitor’s server answered ${reply.status}.`)
  const body = (await reply.json()) as Partial<Snapshot> | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.modules) || typeof body.at !== 'number') throw new Error('Monitor’s server answered with something this page cannot read. Reload it.')
  return { ...emptySnapshot(), ...body } as Snapshot
}

/** This page's own server: the page is served at `/app` on the module's origin. */
function defaultUrl(): string {
  try {
    return new URL('/api/health', location.href).toString()
  } catch {
    return '/api/health'
  }
}

/** The read's address with the person's "Tell agents" on it: `tell=0` when it is off. */
export function tellUrl(url: string, tell: boolean): string {
  return tell ? url : `${url}${url.includes('?') ? '&' : '?'}tell=0`
}

/** One function for every render, so the effect is not started again on each. */
const browserFetch: Fetch = (url) => fetch(url)

/**
 * `tell` says whether the person lets Monitor tell agent sessions about heavy work they started on their
 * own (the header's "Tell agents"): carried on each read, so the server, which tells them, knows.
 */
export function useHealth(on: boolean, paused: boolean, fetcher: Fetch = browserFetch, url: string = defaultUrl(), tell = true): Health {
  const [health, setHealth] = useState<Health>({ snapshot: emptySnapshot(), problem: null })
  useEffect(() => {
    if (!on || paused) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const snapshot = await readHealth(fetcher, tellUrl(url, tell))
        if (live) setHealth({ snapshot, problem: null })
      } catch (error) {
        if (live) setHealth((was) => ({ ...was, problem: error instanceof Error ? error.message : String(error) }))
      }
      if (live) timer = setTimeout(tick, EVERY_MS)
    }
    void tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [on, paused, fetcher, url, tell])
  return health
}
