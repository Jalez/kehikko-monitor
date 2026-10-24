import type { TrafficBudget } from 'kehikot-module-protocol'

import { bytesSaid, type Caller, type CallerSummary } from '../traffic/model.ts'
import { seriesColour } from './timeline.tsx'

/**
 * Who is calling, over the last five minutes: calls a minute, bytes, how many were free, how many
 * came with no reason — the table beside the chart, so every number in it is readable without
 * colour — and the allowances Kehikot spends for you.
 */
export function Summary({ rows, order, budgets }: { rows: readonly CallerSummary[]; order: readonly Caller[]; budgets: readonly TrafficBudget[] }) {
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
      {budgets.map((budget) => (
        <div key={budget.name} className="flex flex-col gap-1 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span>{budget.name}</span>
            <span className="tabular-nums">
              {budget.used} used, {budget.left} left of {budget.limit} an hour
            </span>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full" role="meter" aria-valuemin={0} aria-valuemax={budget.limit} aria-valuenow={budget.used} aria-label={`${budget.name}: ${budget.used} of ${budget.limit} used`}>
            <div className="h-full rounded-full" style={{ width: `${budget.limit ? Math.min(100, (budget.used / budget.limit) * 100) : 0}%`, background: 'var(--series-1)' }} />
          </div>
          {budget.note ? <p className="text-muted-foreground">{budget.note}</p> : null}
        </div>
      ))}
    </section>
  )
}
