import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent, cssKey, type ChartConfig } from '@/components/ui/chart'
import type { TrafficCall } from 'kehikot-module-protocol'

import { BUCKETS_MS, OTHER, buckets, callerLabel, callerOf, freeKey, isFree, type Caller, type Range, type Style } from '../traffic/model.ts'

/**
 * The live timeline: calls per second over the range, a colour per caller (fixed by when it first
 * called, never by rank), in one of three styles the header switches between:
 *
 * - **Lines** (the default): one 2px line per caller, over buckets wide enough to read a line
 *   through (5 s over 5 minutes, 15 s over 15, a minute over an hour). Its free calls — a cache, a
 *   304, held back by a budget — are a DASHED line in the same colour, so they are told apart without
 *   colour. Under `NARROW_PX` only the `LINES_NARROW` busiest callers get a line; the rest are one
 *   grey "Other callers".
 * - **Bars**: every caller stacked, a bar each second (5 s, 15 s over the longer ranges), free calls
 *   in the caller's colour HATCHED.
 * - **Area**: the stack of Bars over the buckets of Lines, smoothed; free calls hatched.
 *
 * Drawn without animation: a new bucket moves the marks by one, nothing else redraws. The legend
 * names every caller drawn in every style; the table of callers below has the same numbers in text.
 */

/** The colour of the caller in slot `i`, or Other's. */
export const seriesColour = (slot: number) => (slot < 0 ? 'var(--series-other)' : `var(--series-${slot + 1})`)

/** Under this many pixels, lines are too many to follow: the busiest few get their own. */
export const NARROW_PX = 420
export const LINES_NARROW = 5

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/** "each bar is a second", "each point is 15 seconds". */
export function bucketSaid(style: Style, ms: number): string {
  const what = style === 'bars' ? 'bar' : 'point'
  const s = ms / 1000
  if (s === 1) return `each ${what} is a second`
  if (s === 60) return `each ${what} is a minute`
  return `each ${what} is ${s} seconds`
}

/**
 * The callers a style draws on their own, in colour order: every coloured one, or, narrow and in
 * lines, the `LINES_NARROW` with the most calls in the range. The rest are Other's.
 */
export function drawnCallers(style: Style, narrow: boolean, shown: readonly Caller[], calls: readonly TrafficCall[], from: number): Caller[] {
  if (style !== 'lines' || !narrow || shown.length <= LINES_NARROW) return [...shown]
  const count = new Map<Caller, number>()
  for (const call of calls) {
    if (call.at < from || call.side === 'seen') continue
    const who = callerOf(call)
    count.set(who, (count.get(who) ?? 0) + 1)
  }
  const top = new Set([...shown].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0)).slice(0, LINES_NARROW))
  return shown.filter((caller) => top.has(caller))
}

/** How wide the figure is, measured; null before it is (and in a test, where nothing has a size). */
function useWidth(): [React.RefObject<HTMLElement | null>, number | null] {
  const ref = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0)
      setWidth((was) => (next > 0 && next !== was ? next : was))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export interface TimelineProps {
  calls: readonly TrafficCall[]
  range: Range
  /** The callers in colour order; others are folded. */
  order: readonly Caller[]
  /** Only these callers are drawn; null is every caller. */
  only: Caller | null
  now: number
  style?: Style
  /** Narrow, said rather than measured (a test); otherwise measured against `NARROW_PX`. */
  narrow?: boolean
}

export const Timeline = memo(function Timeline({ calls, range, order, only, now, style = 'lines', narrow: said }: TimelineProps) {
  const [ref, width] = useWidth()
  const narrow = said ?? (width !== null && width < NARROW_PX)
  const bucketMs = BUCKETS_MS[style][range]
  const from = now - range * 60_000
  const coloured = useMemo(() => (only === null ? order : order.filter((caller) => caller === only)), [order, only])
  const mine = useMemo(() => (only === null ? calls : calls.filter((call) => callerOf(call) === only)), [calls, only])
  const shown = useMemo(() => drawnCallers(style, narrow, coloured, mine, from), [style, narrow, coloured, mine, from])
  const data = useMemo(() => buckets(mine, now, range, shown, bucketMs), [mine, now, range, shown, bucketMs])
  const hasOther = useMemo(() => data.some((bucket) => (bucket[OTHER] ?? 0) + (bucket[freeKey(OTHER)] ?? 0) > 0), [data])
  const series = useMemo(() => [...shown.map((caller) => ({ caller, slot: order.indexOf(caller) })), ...(hasOther ? [{ caller: OTHER, slot: -1 }] : [])], [shown, order, hasOther])
  /* Which callers had free calls in the range: a dashed line is drawn only for those. */
  const freeOf = useMemo(() => {
    const out = new Set<Caller>()
    for (const call of mine) {
      if (call.at < from || call.side === 'seen' || !isFree(call)) continue
      const who = callerOf(call)
      out.add(shown.includes(who) ? who : OTHER)
    }
    return out
  }, [mine, from, shown])
  const labelOf = useMemo(() => {
    const recent = mine.filter((call) => call.at >= from)
    return (caller: Caller) => (caller === OTHER ? 'Other callers' : callerLabel(caller, recent))
  }, [mine, from])
  const config = useMemo(() => {
    const out: ChartConfig = {}
    for (const { caller, slot } of series) {
      const name = labelOf(caller)
      out[caller] = { label: name, color: seriesColour(slot) }
      out[freeKey(caller)] = { label: `${name}, free`, color: seriesColour(slot) }
    }
    return out
  }, [series, labelOf])
  const total = useMemo(() => mine.filter((call) => call.at >= from && call.side !== 'seen').length, [mine, from])

  const grid = <CartesianGrid vertical={false} stroke="var(--grid)" />
  const x = <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={clock} tickLine={false} axisLine={false} minTickGap={48} tick={{ fontSize: 10 }} />
  const y = <YAxis width={28} tickLine={false} axisLine={false} allowDecimals tick={{ fontSize: 10 }} />
  const tooltip = (cursor: object) => (
    <ChartTooltip
      cursor={cursor}
      content={<ChartTooltipContent labelFormatter={(label) => clock(Number(label))} formatter={(value) => `${Math.round(value * 100) / 100}/s`} />}
      isAnimationActive={false}
    />
  )
  const hatches = (
    <defs>
      {series.map(({ caller, slot }) => (
        <pattern key={caller} id={`hatch-${cssKey(caller)}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="var(--background)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke={seriesColour(slot)} strokeWidth="2" />
        </pattern>
      ))}
    </defs>
  )
  const margin = { top: 4, right: 4, bottom: 0, left: 0 }
  const colour = (caller: Caller) => `var(--color-${cssKey(caller)})`

  const chart =
    style === 'bars' ? (
      <BarChart data={data} margin={margin} barCategoryGap={range === 5 ? 0 : 1}>
        {hatches}
        {grid}
        {x}
        {y}
        {tooltip({ fill: 'var(--muted)' })}
        {series.flatMap(({ caller }) => [
          <Bar key={caller} dataKey={caller} stackId="calls" fill={colour(caller)} isAnimationActive={false} />,
          <Bar key={freeKey(caller)} dataKey={freeKey(caller)} stackId="calls" fill={`url(#hatch-${cssKey(caller)})`} isAnimationActive={false} />,
        ])}
      </BarChart>
    ) : style === 'area' ? (
      <AreaChart data={data} margin={margin}>
        {hatches}
        {grid}
        {x}
        {y}
        {tooltip({ stroke: 'var(--border)' })}
        {series.flatMap(({ caller }) => [
          <Area key={caller} type="monotone" dataKey={caller} stackId="calls" stroke={colour(caller)} strokeWidth={2} fill={colour(caller)} fillOpacity={0.3} isAnimationActive={false} />,
          <Area key={freeKey(caller)} type="monotone" dataKey={freeKey(caller)} stackId="calls" stroke="none" fill={`url(#hatch-${cssKey(caller)})`} isAnimationActive={false} />,
        ])}
      </AreaChart>
    ) : (
      <LineChart data={data} margin={margin}>
        {grid}
        {x}
        {y}
        {tooltip({ stroke: 'var(--border)' })}
        {series.flatMap(({ caller }) => [
          <Line
            key={caller}
            type="monotone"
            dataKey={caller}
            stroke={colour(caller)}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--background)' }}
            isAnimationActive={false}
          />,
          ...(freeOf.has(caller)
            ? [<Line key={freeKey(caller)} type="monotone" dataKey={freeKey(caller)} stroke={colour(caller)} strokeWidth={2} strokeDasharray="4 3" dot={false} activeDot={false} isAnimationActive={false} />]
            : []),
        ])}
      </LineChart>
    )

  return (
    <figure ref={ref} className="flex min-w-0 flex-col gap-2" aria-labelledby="timeline-title" data-style={style} data-bucket-ms={bucketMs}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="timeline-title" className="text-sm font-medium">
          Calls per second
        </h2>
        <span className="text-muted-foreground text-xs">
          {total} call{total === 1 ? '' : 's'} in the last {range} minutes · {bucketSaid(style, bucketMs)}
        </span>
      </figcaption>
      <ChartContainer
        config={config}
        className="aspect-auto h-44 w-full"
        role="img"
        aria-label={`Calls per second over the last ${range} minutes, by caller, ${style === 'lines' ? 'a line for each' : style === 'bars' ? 'in stacked bars' : 'in a stacked area'}. The same numbers are in the table of callers below.`}
      >
        {chart}
      </ChartContainer>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Callers">
        {series.map(({ caller, slot }) => (
          <li key={caller} className="flex items-center gap-1.5" data-caller={caller}>
            <span className={style === 'lines' ? 'h-0.5 w-3 shrink-0 rounded-full' : 'size-2.5 shrink-0 rounded-[2px]'} style={{ background: seriesColour(slot) }} aria-hidden />
            {labelOf(caller)}
          </li>
        ))}
        <li className="text-muted-foreground flex items-center gap-1.5">
          {style === 'lines' ? (
            <svg width="12" height="10" aria-hidden className="shrink-0">
              <line x1="0" y1="5" x2="12" y2="5" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
            </svg>
          ) : (
            <svg width="10" height="10" aria-hidden className="shrink-0 rounded-[2px] border">
              <pattern id="legend-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" strokeWidth="2" />
              </pattern>
              <rect width="10" height="10" fill="url(#legend-hatch)" />
            </svg>
          )}
          {style === 'lines' ? 'Dashed' : 'Hatched'}: free — from a cache, a 304, or held back by a budget
        </li>
      </ul>
    </figure>
  )
})
