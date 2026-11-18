import { useCallback, useEffect, useState } from 'react'
import { ask, subscribe } from 'kehikot-module-protocol/client'

import { emptyNet, type NetSnapshot } from '../health/network.ts'
import { applyNet, isEvent, type Event } from '../health/live.ts'
import { emptyQuality, type SpeedState } from '../health/quality.ts'
import { DETACHED, type Follow } from './use-health.ts'
export type { Fetch } from './use-health.ts'

/**
 * The machine's network throughput, pushed by Monitor's own server over one event stream
 * (`/api/network/events`, `live.ts`) while the page is on screen and not paused: the whole snapshot as
 * it opens, then only the new points, and nothing when nothing moved. The page asks nothing on a
 * clock. (It read `/api/network` every 2 s, the whole history each time.)
 */

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

/** One plain read (`GET /api/network`), kept for the tests. Pure but for `fetch`. */
export async function readNetwork(fetcher: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>, url: string): Promise<NetSnapshot> {
  const reply = await fetcher(url)
  if (!reply.ok) throw new Error(`Monitor’s server answered ${reply.status}.`)
  const body = (await reply.json()) as Partial<NetSnapshot> | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.points) || typeof body.at !== 'number') throw new Error('Monitor’s server answered with something this page cannot read. Reload it.')
  return { ...emptyNet(), ...body } as NetSnapshot
}

export const NET_EVENTS = './api/network/events'

export function useNetwork(on: boolean, paused: boolean, follow: Follow = subscribe, url: string = NET_EVENTS): Network & { speed: (action: SpeedAction) => void } {
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
    return follow<Event<NetSnapshot>>(
      url,
      (event) => {
        if (!isEvent(event, 'points')) return setNetwork((was) => ({ ...was, problem: 'Monitor’s server answered with something this page cannot read. Reload it.' }))
        setNetwork((was) => ({ net: applyNet(was.net, event as unknown as Event<NetSnapshot>), problem: null }))
      },
      {
        probe: true,
        onAttachment: (attachment) => {
          if (attachment === 'detached') setNetwork((was) => ({ ...was, problem: DETACHED }))
        },
      },
    )
  }, [on, paused, follow, url])
  return { ...network, speed }
}
