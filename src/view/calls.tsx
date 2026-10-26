import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import type { TrafficCall } from 'kehikot-module-protocol'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { HOW_SAID, bytesSaid, callerName, callerOf, destination, filtered, verb, whoSaid, type Caller, type Filter } from '../traffic/model.ts'
import { seriesColour } from './timeline.tsx'

/**
 * Every call, newest first, filtered by caller and by words (destination, kind, reason). The list
 * is virtual — only the rows on screen are drawn — so five thousand rows scroll like fifty. A row
 * is a button: Enter or Space opens its details.
 */

const ROW = 30

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const SIDE: Record<TrafficCall['side'], string> = { out: 'made', in: 'received by Kehikot', seen: 'seen on a process' }
const REPORTED: Record<TrafficCall['reported'], string> = { host: 'Kehikot recorded it', module: 'the module noted it', sampled: 'Kehikot saw the connection; nobody reported it' }
const CACHE: Record<string, string> = { hit: 'answered from a cache: nothing was sent', 'not-modified': '304 Not Modified: free', refused: 'held back by a budget: nothing was sent' }

/** "curl, under zsh", "claude (pid 4242), under bun": a process by its executable's name, never its arguments. */
export function processSaid(caller: NonNullable<TrafficCall['caller']>): string | null {
  if (!caller.process) return null
  return `${caller.process}${caller.pid ? ` (pid ${caller.pid})` : ''}${caller.parent ? `, under ${caller.parent}` : ''}`
}

export function Details({ call }: { call: TrafficCall }) {
  const who = callerOf(call)
  const caller = call.caller
  const process = caller ? processSaid(caller) : null
  const rows: [string, string][] = [
    ['When', new Date(call.at).toLocaleString()],
    ['Who', `${whoSaid(call)}${call.by ? ` (${call.by})` : ''}, its ${call.via}`],
    ...(caller && caller.name !== callerName(who) ? ([['Filed under', callerName(who)]] as [string, string][]) : []),
    ...(process ? ([['Process', process]] as [string, string][]) : []),
    ...(caller?.place ? ([['Place', caller.place]] as [string, string][]) : []),
    ...(caller ? ([['Told', `Kehikot told who it was ${HOW_SAID[caller.how]}`]] as [string, string][]) : []),
    ['Which way', SIDE[call.side]],
    ['Why', call.reason ?? 'No reason given'],
    ['What', call.kind],
    ['Where', destination(call)],
    ['Answer', call.status === null ? 'not known' : `${call.status}${call.ok === false ? ' (failed)' : ''}`],
    ['Took', call.ms === null ? 'not known' : `${call.ms} ms`],
    ['Bytes', call.bytesIn === undefined && call.bytesOut === undefined ? 'not known' : `${bytesSaid(call.bytesIn ?? 0)} in, ${bytesSaid(call.bytesOut ?? 0)} out`],
    ['Free', call.cache ? CACHE[call.cache]! : 'no: it went over the network'],
    ['Said by', REPORTED[call.reported]],
  ]
  return (
    <dl className="text-muted-foreground grid grid-cols-[6rem_1fr] gap-x-2 gap-y-0.5 px-7 pb-2 text-xs">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt>{term}</dt>
          <dd className="text-foreground min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Calls({
  calls,
  order,
  filter,
  onFilter,
  callers,
}: {
  calls: readonly TrafficCall[]
  order: readonly Caller[]
  filter: Filter
  onFilter: (filter: Filter) => void
  callers: readonly Caller[]
}) {
  const rows = useMemo(() => filtered(calls, filter).reverse(), [calls, filter])
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (open.has(rows[i]!.seq) ? ROW + 200 : ROW),
    getItemKey: (i) => rows[i]!.seq,
    overscan: 8,
  })
  const toggle = (seq: number) =>
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })

  return (
    <section aria-labelledby="calls-title" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="calls-title" className="text-sm font-medium">
          Calls <span className="text-muted-foreground font-normal">({rows.length})</span>
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="calls-caller">
            Caller
          </label>
          <select
            id="calls-caller"
            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
            value={filter.by === null ? '' : `c:${filter.by}`}
            onChange={(event) => onFilter({ ...filter, by: event.target.value ? event.target.value.slice(2) : null })}
          >
            <option value="">Every caller</option>
            {callers.map((caller) => (
              <option key={caller} value={`c:${caller}`}>
                {callerName(caller)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="calls-text">
            Filter by destination, kind or reason
          </label>
          <Input
            id="calls-text"
            className="h-8 w-44 text-xs"
            placeholder="Filter: destination, kind, reason"
            value={filter.text}
            onChange={(event) => onFilter({ ...filter, text: event.target.value })}
          />
        </div>
      </div>
      <div ref={scroller} className="h-80 overflow-auto rounded-md border" role="list" aria-label="Calls, newest first">
        {rows.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">{calls.length ? 'No call matches the filter.' : 'No calls yet. They appear here as they are made.'}</p>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const call = rows[item.index]!
              const expanded = open.has(call.seq)
              return (
                <div key={item.key} data-index={item.index} ref={virtual.measureElement} role="listitem" className="absolute inset-x-0 border-b" style={{ transform: `translateY(${item.start}px)` }}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggle(call.seq)}
                    className="hover:bg-accent focus-visible:bg-accent flex h-[30px] w-full min-w-0 items-center gap-2 px-2 text-left text-xs outline-none"
                  >
                    <ChevronRight className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')} aria-hidden />
                    <span className="text-muted-foreground shrink-0 tabular-nums">{time(call.at)}</span>
                    <span className="flex w-24 shrink-0 items-center gap-1 truncate @md:w-40">
                      <span className="size-2 shrink-0 rounded-[2px]" style={{ background: seriesColour(order.indexOf(callerOf(call))) }} aria-hidden />
                      <span className="truncate" title={whoSaid(call)}>
                        {whoSaid(call)}
                      </span>
                    </span>
                    <span className="sr-only">{verb(call)}</span>
                    <span className="hidden w-24 shrink-0 truncate font-mono @md:inline" title={call.kind}>
                      {call.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={destination(call)}>
                      {destination(call)}
                    </span>
                    <span className={cn('hidden w-40 shrink-0 truncate @md:inline', call.reason === null && 'text-muted-foreground italic')}>{call.reason ?? 'no reason given'}</span>
                    {call.cache ? <span className="text-muted-foreground shrink-0">free</span> : null}
                    <span className={cn('w-8 shrink-0 text-right tabular-nums', call.ok === false && 'text-destructive font-medium')}>{call.status ?? '—'}</span>
                  </button>
                  {expanded ? <Details call={call} /> : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
