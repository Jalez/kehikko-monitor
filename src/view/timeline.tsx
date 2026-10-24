import { memo, useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent, cssKey, type ChartConfig } from '@/components/ui/chart'
import type { TrafficCall } from 'kehikot-module-protocol'

import { BUCKET_MS, OTHER, buckets, callerName, freeKey, type Caller, type Range } from '../traffic/model.ts'

/**
 * The live timeline: calls per second over the range, one stacked bar per bucket, a colour per
 * caller (fixed by when it first called, never by rank) and its free calls — a cache, a 304, held
 * back by a budget — in the same colour HATCHED, so they are told apart without colour too. Drawn
 * without animation: a new bucket each second moves the bars by one, nothing else redraws.
 */

/** The colour of the caller in slot `i`, or Other's. */
export const seriesColour = (slot: number) => (slot < 0 ? 'var(--series-other)' : `var(--series-${slot + 1})`)

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export interface TimelineProps {
  calls: readonly TrafficCall[]
  range: Range
  /** The callers in colour order; others are folded. */
  order: readonly Caller[]
  /** Only these callers are drawn; null is every caller. */
  only: Caller | null
  now: number
}

export const Timeline = memo(function Timeline({ calls, range, order, only, now }: TimelineProps) {
  const shown = useMemo(() => (only === null ? order : order.filter((caller) => caller === only)), [order, only])
  const mine = useMemo(() => (only === null ? calls : calls.filter((call) => call.by === only)), [calls, only])
  const data = useMemo(() => buckets(mine, now, range, shown), [mine, now, range, shown])
  const hasOther = useMemo(() => data.some((bucket) => (bucket[OTHER] ?? 0) + (bucket[freeKey(OTHER)] ?? 0) > 0), [data])
  const series = useMemo(() => [...shown.map((caller) => ({ caller, slot: order.indexOf(caller) })), ...(hasOther ? [{ caller: OTHER, slot: -1 }] : [])], [shown, order, hasOther])
  const config = useMemo(() => {
    const out: ChartConfig = {}
    for (const { caller, slot } of series) {
      const name = caller === OTHER ? 'Other callers' : callerName(caller)
      out[caller] = { label: name, color: seriesColour(slot) }
      out[freeKey(caller)] = { label: `${name}, free`, color: seriesColour(slot) }
    }
    return out
  }, [series])
  const total = useMemo(() => mine.filter((call) => call.at >= now - range * 60_000 && call.side !== 'seen').length, [mine, now, range])
  const width = BUCKET_MS[range] / 1000

  return (
    <figure className="flex min-w-0 flex-col gap-2" aria-labelledby="timeline-title">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="timeline-title" className="text-sm font-medium">
          Calls per second
        </h2>
        <span className="text-muted-foreground text-xs">
          {total} call{total === 1 ? '' : 's'} in the last {range} minutes · {width === 1 ? 'each bar is a second' : `each bar is ${width} seconds`}
        </span>
      </figcaption>
      <ChartContainer config={config} className="aspect-auto h-44 w-full" role="img" aria-label={`Calls per second over the last ${range} minutes, by caller. The same numbers are in the table of callers below.`}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={range === 5 ? 0 : 1}>
          <defs>
            {series.map(({ caller, slot }) => (
              <pattern key={caller} id={`hatch-${cssKey(caller)}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="4" fill="var(--background)" />
                <line x1="0" y1="0" x2="0" y2="4" stroke={seriesColour(slot)} strokeWidth="2" />
              </pattern>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={clock} tickLine={false} axisLine={false} minTickGap={48} tick={{ fontSize: 10 }} />
          <YAxis width={28} tickLine={false} axisLine={false} allowDecimals tick={{ fontSize: 10 }} />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)' }}
            content={<ChartTooltipContent labelFormatter={(label) => clock(Number(label))} formatter={(value) => `${Math.round(value * 100) / 100}/s`} />}
            isAnimationActive={false}
          />
          {series.flatMap(({ caller }) => [
            <Bar key={caller} dataKey={caller} stackId="calls" fill={`var(--color-${cssKey(caller)})`} isAnimationActive={false} />,
            <Bar key={freeKey(caller)} dataKey={freeKey(caller)} stackId="calls" fill={`url(#hatch-${cssKey(caller)})`} isAnimationActive={false} />,
          ])}
        </BarChart>
      </ChartContainer>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Callers">
        {series.map(({ caller, slot }) => (
          <li key={caller} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: seriesColour(slot) }} aria-hidden />
            {caller === OTHER ? 'Other callers' : callerName(caller)}
          </li>
        ))}
        <li className="text-muted-foreground flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden className="shrink-0 rounded-[2px] border">
            <pattern id="legend-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="2" />
            </pattern>
            <rect width="10" height="10" fill="url(#legend-hatch)" />
          </svg>
          Hatched: free — from a cache, a 304, or held back by a budget
        </li>
      </ul>
    </figure>
  )
})
