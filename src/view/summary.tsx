import { CirclePause } from 'lucide-react'
import type { TrafficBudget, TrafficLimits } from 'kehikot-module-protocol'

import { budgetLines } from '../traffic/budgets.ts'

import { bytesSaid, type Caller, type CallerSummary } from '../traffic/model.ts'
import { seriesColour } from './timeline.tsx'

/**
 * Who is calling, over the last five minutes: calls a minute, bytes, how many were free, how many
 * came with no reason — the table beside the chart, so every number in it is readable without
 * colour — and the allowances Kehikot spends for you.
 */
export function Summary({
  rows,
  order,
  budgets,
  limits = null,
}: {
  rows: readonly CallerSummary[]
  order: readonly Caller[]
  budgets: readonly TrafficBudget[]
  limits?: TrafficLimits | null
}) {
  const lines = budgetLines(limits, budgets)
  return (
    <section aria-labelledby="summary-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="summary-title" className="text-sm font-medium">
        Callers, last 5 minutes
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">No calls yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums [&_td]:whitespace-nowrap">
            <thead className="text-muted-foreground text-left">
              <tr>
                <th className="py-1 pr-2 font-normal">Caller</th>
                <th className="py-1 pr-2 text-right font-normal">Calls/min</th>
                <th className="hidden py-1 pr-2 text-right font-normal @md:table-cell">Bytes</th>
                <th className="py-1 pr-2 text-right font-normal">Free</th>
                <th className="py-1 pr-2 text-right font-normal">No reason</th>
                <th className="hidden py-1 text-right font-normal @md:table-cell">Seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.by} className="border-t">
                  <td className="py-1 pr-2">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: seriesColour(order.indexOf(row.by)) }} aria-hidden />
                      {row.name}
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-right">{row.perMinute}</td>
                  <td className="hidden py-1 pr-2 text-right @md:table-cell">{row.bytes ? bytesSaid(row.bytes) : '—'}</td>
                  <td className="py-1 pr-2 text-right">{row.calls ? `${Math.round(row.freeRate * 100)}%` : '—'}</td>
                  <td className="py-1 pr-2 text-right">{row.unlabelled}</td>
                  <td className="hidden py-1 text-right @md:table-cell" title="Connections seen on its processes that nobody reported">
                    {row.seen}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lines.length ? (
        <ul aria-label="Limits Kehikot spends for you" className="flex flex-col gap-1.5 text-xs">
          {lines.map((line) => (
            <li key={line.key} className="flex min-w-0 flex-col gap-1">
              <span className={line.paused ? 'flex items-start gap-1.5 font-medium' : 'break-words'}>
                {line.paused ? <CirclePause className="mt-px size-3.5 shrink-0" aria-hidden /> : null}
                <span className="min-w-0 break-words">{line.text}</span>
              </span>
              {line.meter ? (
                <div
                  className="bg-muted h-1.5 overflow-hidden rounded-full"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={line.meter.limit}
                  aria-valuenow={line.meter.used}
                  aria-label={line.meter.label}
                >
                  <div className="h-full rounded-full" style={{ width: `${line.meter.limit ? Math.min(100, (line.meter.used / line.meter.limit) * 100) : 0}%`, background: 'var(--series-1)' }} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
