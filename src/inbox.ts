import { useEffect, useMemo } from 'react'
import { activityItemSchema, type ActivityItem } from 'kehikot-module-protocol'

import { outsideSaid, outsideWhat, type Outside } from './health/heavy.ts'

/**
 * What Monitor puts in the person's Inbox: one item per run of heavy work an agent session started on
 * its own, while it runs. `working` and `normal`: something going on, never "needs you". Reported whole
 * (`activity.set`) whenever the runs change, so an item goes when its process ends. One item per run: its
 * id is the run's pid. The host's "Use inbox" for Monitor holds.
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

/**
 * Report the runs to the Inbox when the set of runs (or the provider's name) changes: not on every read,
 * since only the CPU moves between two. An empty list clears them.
 */
export function useHeavyInbox(activity: ((items: ActivityItem[]) => unknown) | undefined, outside: readonly Outside[] | undefined, provider: string | null | undefined): void {
  const runs = outside ?? []
  const key = `${provider ?? ''}|${runs.map((one) => `${one.pid}:${one.word}:${one.session ?? one.sessionPid}`).join(',')}`
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  const items = useMemo(() => heavyItems(runs, provider ?? null), [key])
  useEffect(() => {
    activity?.(items)
  }, [activity, items])
}
