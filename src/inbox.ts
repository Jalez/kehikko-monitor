import { useEffect, useMemo } from 'react'
import { LIMITS, activityItemSchema, type ActivityItem } from 'kehikot-module-protocol'

import { outsideSaid, outsideWhat, type Outside } from './health/heavy.ts'
import { BAD_FOR_MS, type Quality } from './health/quality.ts'

/**
 * What Monitor puts in the person's Inbox, reported whole (`activity.set`) whenever it changes, so an item
 * goes when what it says is over. The host's "Use inbox" for Monitor holds.
 *
 * - One item per run of heavy work an agent session started on its own, while it runs: `working` and
 *   `normal`, never "needs you". Its id is the run's pid.
 * - One item while the connection has been Poor or Offline for more than `BAD_FOR_MS`: `working` and
 *   `normal`, a thing going on that nobody has to answer; it goes when the connection recovers.
 */
export function heavyItems(outside: readonly Outside[], provider: string | null): ActivityItem[] {
  return outside.map((one) =>
    activityItemSchema.parse({
      id: `heavy-${one.pid}`,
      state: 'working',
      priority: 'normal',
      label: `${one.word} running outside ${outsideWhat(provider)}`,
      detail: `${outsideSaid([one], provider)}.`,
      group: 'Heavy work',
    }),
  )
}

/** The connection's item, when it has been Poor or Offline for more than a minute at `now`; none otherwise. */
export function connectionItems(quality: Pick<Quality, 'badSince' | 'verdict'> | null | undefined, now: number): ActivityItem[] {
  if (!quality || quality.badSince === null || now - quality.badSince < BAD_FOR_MS) return []
  const { verdict } = quality
  if (verdict.level !== 'poor' && verdict.level !== 'offline') return []
  return [
    activityItemSchema.parse({
      id: 'connection',
      state: 'working',
      priority: 'normal',
      since: quality.badSince,
      label: verdict.level === 'offline' ? 'This computer is offline' : 'The internet connection is poor',
      detail: `${verdict.word}: ${verdict.reason}. Pushes, pulls and downloads may be slow or fail; this goes when it recovers.`.slice(0, LIMITS.ACTIVITY_DETAIL),
      group: 'Connection',
    }),
  ]
}

/**
 * Report Monitor's items when they change (the runs, the provider's name, the connection's item): not on
 * every read, since only the CPU and the round trip move between two. An empty list clears them.
 */
export function useInbox(
  activity: ((items: ActivityItem[]) => unknown) | undefined,
  outside: readonly Outside[] | undefined,
  provider: string | null | undefined,
  quality: Pick<Quality, 'badSince' | 'verdict' | 'at'> | null = null,
): void {
  const runs = outside ?? []
  const connection = connectionItems(quality, quality?.at ?? 0)
  const key = `${provider ?? ''}|${runs.map((one) => `${one.pid}:${one.word}:${one.session ?? one.sessionPid}`).join(',')}|${connection.map((one) => `${one.label}:${one.detail}`).join(',')}`
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  const items = useMemo(() => [...heavyItems(runs, provider ?? null), ...connection], [key])
  useEffect(() => {
    activity?.(items)
  }, [activity, items])
}
