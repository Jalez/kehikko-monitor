import { useCallback, useEffect, useState } from 'react'
import { ask } from 'kehikot-module-protocol/client'

import { emptyNet, type NetSnapshot } from '../health/network.ts'
import { emptyQuality, type SpeedState } from '../health/quality.ts'
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

export type SpeedAction = 'start' | 'cancel'

/** What a press of Test speed or Cancel is: the server's answer, the test's state; a sentence when it refused. */
export type Asker = (path: string, options: { body: unknown }) => Promise<{ ok: boolean; body: unknown; error?: string }>

/** Start or cancel the speed test on Monitor's server (`POST /api/speed`, with the page's ticket). */
export async function pressSpeed(action: SpeedAction, asker: Asker = ask as unknown as Asker): Promise<SpeedState | string> {
  const reply = await asker('/api/speed', { body: { action } })
  const speed = (reply.body as { speed?: SpeedState } | null)?.speed
  if (!reply.ok || !speed) return reply.error ?? 'Monitor’s server would not run the speed test.'
  return speed
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

export function useNetwork(on: boolean, paused: boolean, fetcher: Fetch = browserFetch, url: string = defaultUrl()): Network & { speed: (action: SpeedAction) => void } {
  const [network, setNetwork] = useState<Network>({ net: emptyNet(), problem: null })
  /* The test's state as the server answered the press, at once: the next read carries it on. */
  const speed = useCallback((action: SpeedAction) => {
    void pressSpeed(action).then((said) => {
      setNetwork((was) => {
        const quality = was.net.quality ?? emptyQuality()
        const next: SpeedState = typeof said === 'string' ? { ...quality.speed, state: 'failed', phase: null, why: said } : said
        return { ...was, net: { ...was.net, quality: { ...quality, speed: next } } }
      })
    })
  }, [])
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
  return { ...network, speed }
}
