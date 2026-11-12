import { useEffect, useState } from 'react'

import { emptyNet, type NetSnapshot } from '../health/network.ts'
import type { Fetch } from './use-health.ts'

/**
 * The machine's network throughput, from Monitor's own server (`GET /api/network`), every `NET_EVERY_MS`
 * while the page is open and not paused. The server reads the counters only while it is asked, so a
 * closed page stops that too.
 */

export const NET_EVERY_MS = 2000

export interface Network {
  net: NetSnapshot
  /** A sentence when the server would not answer. */
  problem: string | null
}

/** One read. Pure but for `fetch`, so a test drives it. */
export async function readNetwork(fetcher: Fetch, url: string): Promise<NetSnapshot> {
  const reply = await fetcher(url)
  if (!reply.ok) throw new Error(`Monitor’s server answered ${reply.status}.`)
  const body = (await reply.json()) as Partial<NetSnapshot> | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.points) || typeof body.at !== 'number') throw new Error('Monitor’s server answered with something this page cannot read. Reload it.')
  return { ...emptyNet(), ...body } as NetSnapshot
}

function defaultUrl(): string {
  try {
    return new URL('/api/network', location.href).toString()
  } catch {
    return '/api/network'
  }
}

const browserFetch: Fetch = (url) => fetch(url)

export function useNetwork(on: boolean, paused: boolean, fetcher: Fetch = browserFetch, url: string = defaultUrl()): Network {
  const [network, setNetwork] = useState<Network>({ net: emptyNet(), problem: null })
  useEffect(() => {
    if (!on || paused) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const net = await readNetwork(fetcher, url)
        if (live) setNetwork({ net, problem: null })
      } catch (error) {
        /* An older server has no /api/network: the tile says so, and nothing else changes. */
        if (live) setNetwork((was) => ({ ...was, problem: error instanceof Error ? error.message : String(error) }))
      }
      if (live) timer = setTimeout(tick, NET_EVERY_MS)
    }
    void tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [on, paused, fetcher, url])
  return network
}
